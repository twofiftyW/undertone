package personal.undertone.player

import android.app.Activity
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.util.Base64
import android.util.JsonReader
import android.util.JsonToken
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
import java.io.StringReader
import java.net.NetworkInterface
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity() {
    private lateinit var webView: WebView
    internal val updates by lazy { AppUpdates(this) }
    private lateinit var phoneDiscovery: PhoneDiscovery
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var unregisterBackCallback: (() -> Unit)? = null
    private val openSpotifyImport = AtomicBoolean(false)

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
                    response.responseHeaders = mapOf("Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; connect-src 'self' https://discoveryprovider.audius.co https://api.audius.co https://*.workers.dev; object-src 'none'; frame-src 'none'; base-uri 'self'")
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
        handleImportIntent(intent)
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleImportIntent(intent)
    }

    private fun handleImportIntent(intent: Intent?) {
        if (intent?.action != SpotifyImportService.OPEN_IMPORT) return
        intent.action = null
        openSpotifyImport.set(true)
        webView.evaluateJavascript("if (window.undertoneOpenSpotifyImport && window.UndertoneDevice.consumeSpotifyImportIntent()) window.undertoneOpenSpotifyImport()", null)
    }

    fun consumeImportIntent(): Boolean = openSpotifyImport.getAndSet(false)

    fun requestImportNotifications() = runOnUiThread {
        if (Build.VERSION.SDK_INT < 33 || isFinishing || isDestroyed ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return@runOnUiThread
        val preferences = getSharedPreferences("spotify-import", Context.MODE_PRIVATE)
        if (!preferences.getBoolean("askedForNotifications", false)) {
            preferences.edit().putBoolean("askedForNotifications", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
        }
    }

    private fun navigateBack() {
        webView.evaluateJavascript("window.undertoneBack?.()", null)
    }

    @Deprecated("Used by the legacy Android back dispatcher")
    override fun onBackPressed() = navigateBack()

    @Deprecated("Legacy result API remains available on Android 8+")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == AppUpdates.INSTALL_PERMISSION) {
            updates.permissionResult()
            return
        }
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
        updates.destroy()
        chooser?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }
}

class DeviceBridge(private val context: Context, private val callback: (String, String) -> Unit) {
    companion object {
        private val libraryWriter = Executors.newSingleThreadExecutor()
        private val workers = Executors.newFixedThreadPool(3)
    }
    val phoneDiscovery = PhoneDiscovery(context.applicationContext)
    private val launcherIcons = LauncherIcons(context)
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
        if (!Regex("[a-z0-9-]{1,60}").matches(id) || args.length > 2 * 1024 * 1024) return
        if (operation == "app_update") {
            (context as? MainActivity)?.updates?.request(args) { response -> callback(id, response) }
            return
        }
        val job = operation.startsWith("spotify_job_") || operation.startsWith("download_job_")
        val action = operation.substringAfter("_job_")
        if (job && (action in setOf("start", "resume") || action == "pause" && SpotifyImportService.isActive(operation))) {
            SpotifyImportService.command(context, operation, args) { response -> callback(id, response) }
            if (action != "pause") (context as? MainActivity)?.requestImportNotifications()
            return
        }
        if (job && action in setOf("status", "results", "ack", "pause")) {
            workers.execute {
                val response = try {
                    val data = Engine.call(context, operation, JSONObject(args))
                    if (action == "status") data.put("serviceActive", SpotifyImportService.isActive(operation))
                    JSONObject().put("data", data).toString()
                } catch (error: Exception) {
                    JSONObject().put("error", error.message ?: "Could not read background progress.").toString()
                }
                callback(id, response)
            }
            return
        }
        if (operation in PhoneDiscovery.operations) {
            phoneDiscovery.request(operation, args) { response -> callback(id, response) }
            return
        }
        if (operation !in setOf("music", "list_downloads", "offline_file", "download_track", "remove_download", "parse_spotify", "link_status", "link_discover", "link_pair", "link_forget", "link_pull")) return
        workers.execute {
            val response = try { Engine.reply(context, operation, when (operation) {
                "link_discover" -> discoveryArgs()
                "link_pair" -> JSONObject(args).put("name", Build.MODEL).toString()
                else -> args
            }) } catch (_: Exception) { JSONObject().put("error", "The music engine could not start. Restart Undertone and try again.").toString() }
            callback(id, response)
        }
    }

    @JavascriptInterface fun getAppIcon(): String = reply { launcherIcons.current() }
    @JavascriptInterface fun consumeSpotifyImportIntent(): Boolean = (context as? MainActivity)?.consumeImportIntent() ?: false
    @JavascriptInterface fun appVersion(): String = BuildConfig.VERSION_NAME
    @JavascriptInterface fun setAppIcon(id: String): String = reply { launcherIcons.select(id) }

    private val importDirectory = File(context.cacheDir, "spotify-imports")
    private fun importJob(token: String): File {
        require(token.matches(Regex("[a-f0-9]{32}")))
        return File(importDirectory, token)
    }
    @JavascriptInterface fun beginImport(): String = reply {
        val expired = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        importDirectory.listFiles()?.filter { it.lastModified() < expired }?.forEach { it.deleteRecursively() }
        val token = java.util.UUID.randomUUID().toString().replace("-", "")
        val job = importJob(token)
        check(job.mkdirs())
        check(File(job, "export").createNewFile())
        token
    }
    @JavascriptInterface fun appendImport(token: String, chunk: String): String = reply {
        require(chunk.length <= 64 * 1024)
        val target = File(importJob(token), "export")
        require(target.isFile)
        val bytes = Base64.decode(chunk, Base64.DEFAULT)
        require(target.length() + bytes.size <= 32 * 1024 * 1024)
        FileOutputStream(target, true).use { it.write(bytes) }
        true
    }
    @JavascriptInterface fun importPage(token: String, page: Int): String {
        require(page >= 0)
        return File(importJob(token), "$page.json").readText()
    }
    @JavascriptInterface fun endImport(token: String): String = reply { importJob(token).deleteRecursively() }
    @JavascriptInterface fun spotifyHelp(): String = reply {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.spotify.com/account/privacy/")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
    }

    @JavascriptInterface fun githubSignIn(): String = reply {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/login/device")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    }

    @JavascriptInterface fun loadLibrary(): String = libraryWriter.submit<String> { readLibrary() }.get()

    private fun readLibrary(): String = reply {
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
    @JavascriptInterface fun saveLibrary(json: String): String = libraryWriter.submit<String> { writeLibrary(json) }.get()

    private fun writeLibrary(json: String): String = reply {
        require(json.length <= 64 * 1024 * 1024)
        JsonReader(StringReader(json)).use { reader ->
            var version = 0
            reader.beginObject()
            while (reader.hasNext()) {
                if (reader.nextName() == "version") version = reader.nextInt() else reader.skipValue()
            }
            reader.endObject()
            require(version == 1 && reader.peek() == JsonToken.END_DOCUMENT)
        }
        val temporary = File.createTempFile("library-", ".tmp", context.filesDir)
        try {
            FileOutputStream(temporary).use { output ->
                val writer = output.writer(Charsets.UTF_8).buffered()
                writer.write(json)
                writer.flush()
                output.fd.sync()
            }
            check(temporary.renameTo(File(context.filesDir, "library.json")))
        } finally {
            temporary.delete()
        }
        true
    }
    @JavascriptInterface fun saveLibraryAsync(id: String, json: String) {
        libraryWriter.execute { callback(id, writeLibrary(json)) }
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
