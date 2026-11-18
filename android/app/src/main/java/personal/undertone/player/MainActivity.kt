package personal.undertone.player

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.WindowInsets
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.NetworkInterface
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var phoneDiscovery: PhoneDiscovery
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var unregisterBackCallback: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(17, 20, 19)
        window.navigationBarColor = Color.rgb(13, 20, 15)
        val audio = File(filesDir, "audio").apply { mkdirs() }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).addPathHandler("/audio/", WebViewAssetLoader.InternalStoragePathHandler(this, audio)).build()
        webView = WebView(this)
        webView.setBackgroundColor(Color.rgb(17, 20, 19))
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = true
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? {
                val response = loader.shouldInterceptRequest(request.url)
                if (response != null && request.url.path == "/assets/index.html") {
                    response.responseHeaders = mapOf("Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; connect-src 'self' https://discoveryprovider.audius.co https://api.audius.co; object-src 'none'; frame-src 'none'; base-uri 'self'")
                }
                return response
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean = request.url.scheme != "https" || request.url.host != "appassets.androidplatform.net"
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>, params: FileChooserParams?): Boolean {
                chooser?.onReceiveValue(null)
                chooser = callback
                val export = params?.acceptTypes?.any { it.contains("json") || it.contains("csv") || it.contains("zip") } == true
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(if (export) "*/*" else "audio/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                try { startActivityForResult(intent, 41) } catch (_: Exception) { chooser?.onReceiveValue(null); chooser = null }
                return true
            }
        }
        // A fixed local origin and blocked document navigation keep the bridges private.
        val deviceBridge = DeviceBridge(this) { id, reply ->
            webView.post { if (!isFinishing && !isDestroyed) webView.evaluateJavascript("window.__undertoneReply?.(" + JSONObject.quote(id) + "," + reply + ")", null) }
        }
        phoneDiscovery = deviceBridge.phoneDiscovery
        webView.addJavascriptInterface(deviceBridge, "UndertoneDevice")
        webView.addJavascriptInterface(PlaybackBridge(applicationContext), "UndertoneAudio")
        val frame = FrameLayout(this)
        frame.setBackgroundColor(Color.rgb(17, 20, 19))
        frame.addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        if (Build.VERSION.SDK_INT >= 35) {
            frame.setOnApplyWindowInsetsListener { container, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                container.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
                WindowInsets.CONSUMED
            }
        }
        setContentView(frame)
        if (Build.VERSION.SDK_INT >= 33) {
            val dispatcher = onBackInvokedDispatcher
            val callback = OnBackInvokedCallback(::navigateBack)
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            unregisterBackCallback = { dispatcher.unregisterOnBackInvokedCallback(callback) }
        }
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    private fun navigateBack() {
        webView.evaluateJavascript("window.undertoneBack?.()", null)
    }

    @Deprecated("Used by the legacy Android back dispatcher")
    override fun onBackPressed() = navigateBack()

    @Deprecated("Legacy result API remains available on Android 8+")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 41) return
        val files = if (resultCode != RESULT_OK || data == null) null else data.clipData?.let { clips -> Array(clips.itemCount) { clips.getItemAt(it).uri } } ?: data.data?.let { arrayOf(it) }
        chooser?.onReceiveValue(files)
        chooser = null
    }

    override fun onStart() { super.onStart(); phoneDiscovery.setForeground(true) }
    override fun onStop() { phoneDiscovery.setForeground(false); super.onStop() }
    override fun onDestroy() {
        unregisterBackCallback?.invoke()
        phoneDiscovery.destroy()
        chooser?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }
}

class DeviceBridge(private val context: Context, private val callback: (String, String) -> Unit) {
    val phoneDiscovery = PhoneDiscovery(context.applicationContext)
    private val launcherIcons = LauncherIcons(context)
    private val workers = Executors.newFixedThreadPool(3)
    private val directory = File(context.filesDir, "audio").apply { mkdirs() }
    private fun file(id: String): File {
        require(Regex("[a-f0-9]{64}\\.[a-z0-9]{1,10}").matches(id))
        return File(directory, id)
    }
    private fun reply(operation: () -> Any?): String = try { JSONObject().put("data", operation() ?: JSONObject.NULL).toString() } catch (_: Exception) { JSONObject().put("error", "Could not access app storage. Check free space and restart the app.").toString() }

    private fun discoveryArgs(): String {
        val broadcasts = linkedSetOf("255.255.255.255")
        // A subnet broadcast also reaches Wi-Fi when another interface has the default route.
        runCatching {
            for (network in NetworkInterface.getNetworkInterfaces().asSequence()) {
                if (!network.isUp || network.isLoopback || network.isPointToPoint) continue
                for (entry in network.interfaceAddresses) {
                    if (entry.address.isSiteLocalAddress || entry.address.isLinkLocalAddress) {
                        entry.broadcast?.hostAddress?.let { broadcasts.add(it) }
                    }
                }
            }
        }
        return JSONObject().put("broadcasts", JSONArray(broadcasts)).toString()
    }

    @JavascriptInterface fun request(id: String, operation: String, args: String) {
        if (!Regex("[a-z0-9-]{1,60}").matches(id) || args.length > 1024 * 1024) return
        if (operation in PhoneDiscovery.operations) {
            phoneDiscovery.request(operation, args) { response -> callback(id, response) }
            return
        }
        if (operation !in setOf("music", "list_downloads", "offline_file", "download_track", "remove_download", "parse_spotify", "link_status", "link_discover", "link_pair", "link_forget", "link_pull")) return
        workers.execute {
            val response = try { Engine.reply(context, operation, if (operation == "link_discover") discoveryArgs() else args) } catch (_: Exception) { JSONObject().put("error", "The music engine could not start. Restart Undertone and try again.").toString() }
            callback(id, response)
        }
    }

    @JavascriptInterface fun getAppIcon(): String = reply { launcherIcons.current() }
    @JavascriptInterface fun appVersion(): String = BuildConfig.VERSION_NAME
    @JavascriptInterface fun setAppIcon(id: String): String = reply { launcherIcons.select(id) }

    @JavascriptInterface fun beginImport(): String = reply { FileOutputStream(File(context.filesDir, "spotify-import.tmp")).use { }; true }
    @JavascriptInterface fun appendImport(chunk: String): String = reply {
        require(chunk.length <= 64 * 1024)
        val target = File(context.filesDir, "spotify-import.tmp")
        val bytes = Base64.decode(chunk, Base64.DEFAULT)
        require(target.length() + bytes.size <= 32 * 1024 * 1024)
        FileOutputStream(target, true).use { it.write(bytes) }
        true
    }
    @JavascriptInterface fun spotifyHelp(): String = reply {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.spotify.com/account/privacy/")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
    }

    @JavascriptInterface fun loadLibrary(): String = reply {
        val file = File(context.filesDir, "library.json")
        if (file.exists()) JSONObject(file.readText()).apply {
            val history = context.getSharedPreferences("playlist-playback", Context.MODE_PRIVATE)
            optJSONArray("playlists")?.let { playlists ->
                for (index in 0 until playlists.length()) {
                    val playlist = playlists.getJSONObject(index)
                    playlist.put("lastPlayedAt", maxOf(playlist.optLong("lastPlayedAt"), history.getLong(playlist.getString("id"), 0)))
                }
            }
        } else null
    }
    @JavascriptInterface fun saveLibrary(json: String): String = reply {
        require(json.length <= 64 * 1024 * 1024 && JSONObject(json).getInt("version") == 1)
        val temporary = File(context.filesDir, "library.json.tmp")
        FileOutputStream(temporary).use { it.write(json.toByteArray(Charsets.UTF_8)); it.fd.sync() }
        check(temporary.renameTo(File(context.filesDir, "library.json")))
        true
    }
    @JavascriptInterface fun hasAudio(id: String, bytes: Int): String = reply {
        val target = file(id)
        target.isFile && target.length() == bytes.toLong()
    }
    @JavascriptInterface fun beginAudio(id: String): String = reply { FileOutputStream(File(file(id).path + ".tmp")).use { }; true }
    @JavascriptInterface fun appendAudio(id: String, chunk: String): String = reply {
        require(chunk.length <= 512 * 1024)
        val target = File(file(id).path + ".tmp")
        val bytes = Base64.decode(chunk, Base64.DEFAULT)
        require(target.length() + bytes.size <= 256 * 1024 * 1024)
        FileOutputStream(target, true).use { it.write(bytes) }
        true
    }
    @JavascriptInterface fun finishAudio(id: String): String = reply {
        val target = file(id)
        val temporary = File(target.path + ".tmp")
        require(temporary.length() in 1..(256L * 1024 * 1024))
        check(temporary.renameTo(target))
        target.path
    }
    @JavascriptInterface fun deleteAudio(id: String): String = reply { val target = file(id); check(!target.exists() || target.delete()); true }
    @JavascriptInterface fun audioURL(path: String): String = reply {
        val target = File(path)
        require(target.canonicalPath == file(target.name).canonicalPath)
        "https://appassets.androidplatform.net/audio/" + Uri.encode(target.name)
    }
}

class PlaybackBridge(private val context: Context) {
    @JavascriptInterface fun loadQueue(payload: String) {
        if (payload.length > 20 * 1024 * 1024) return
        val request = PlaybackService.queueRequest(payload)
        context.startForegroundService(Intent(context, PlaybackService::class.java).setAction("load").putExtra("request", request))
    }
    @JavascriptInterface fun replaceQueue(payload: String) {
        if (!PlaybackService.running || payload.length > 20 * 1024 * 1024) return
        val request = PlaybackService.queueRequest(payload)
        context.startService(Intent(context, PlaybackService::class.java).setAction("replace").putExtra("request", request))
    }
    @JavascriptInterface fun command(action: String, value: String) {
        if (!PlaybackService.running || action !in setOf("toggle", "next", "previous", "seek", "volume", "shuffle", "repeat", "language", "stop")) return
        context.startService(Intent(context, PlaybackService::class.java).setAction(action).putExtra("value", value.take(64)))
    }
    @JavascriptInterface fun state(): String = PlaybackService.snapshot
    @JavascriptInterface fun queue(): String = PlaybackService.queueSnapshot
}
