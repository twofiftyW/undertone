package personal.undertone.player

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import com.chaquo.python.PyObject
import org.json.JSONObject
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Answers PC discovery requests only while the connection dialog is visible. */
class PhoneDiscovery(private val context: Context) {
    companion object {
        val operations = setOf("link_phone_start", "link_phone_status", "link_phone_stop")
    }

    private val worker = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
    @Volatile private var foreground = false
    private var session: String? = null
    private var receiver: PyObject? = null
    private var wifiLock: WifiManager.MulticastLock? = null
    private var expiry: ScheduledFuture<*>? = null

    fun setForeground(visible: Boolean) {
        foreground = visible
        if (!visible) worker.execute { stop() }
    }

    @Synchronized fun destroy() {
        setForeground(false)
        worker.shutdown()
    }

    @Synchronized fun request(operation: String, args: String, reply: (String) -> Unit) {
        if (worker.isShutdown) return
        worker.execute {
            val response = try {
                val id = JSONObject(args).getString("session")
                require(id.isNotBlank() && id.length <= 64)
                JSONObject().put("data", handle(operation, id))
            } catch (_: Exception) {
                JSONObject().put("error", "This phone could not become visible to PCs.")
            }
            reply(response.toString())
        }
    }

    private fun handle(operation: String, id: String): JSONObject {
        if (operation == "link_phone_stop") {
            if (id == session) stop()
            return JSONObject().put("active", false)
        }
        if (!foreground) return JSONObject().put("active", false)
        if (operation == "link_phone_start" && id != session) {
            stop()
            val name = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            receiver = Engine.openPhoneDiscovery(context, name?.takeIf { it.isNotBlank() } ?: Build.MODEL)
            session = id
            val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            wifiLock = runCatching { wifi?.createMulticastLock("Undertone discovery")?.apply { acquire() } }.getOrNull()
        }
        val phone = receiver
        if (id != session || phone == null) return JSONObject().put("active", false)
        // Release the socket and Wi-Fi lock if the WebView is suspended or destroyed.
        expiry?.cancel(false)
        expiry = worker.schedule({ stop() }, 12, TimeUnit.SECONDS)
        val result = JSONObject().put("active", true).put("name", phone["name"].toString())
        if (operation == "link_phone_status") {
            val invite = phone.callAttr("take_invitation")
            if (invite != null) result.put("invitation", JSONObject()
                .put("name", invite.callAttr("get", "name").toString())
                .put("address", invite.callAttr("get", "address").toString()))
        }
        return result
    }

    private fun stop() {
        expiry?.cancel(false)
        expiry = null
        session = null
        try {
            receiver?.callAttr("close")
        } finally {
            receiver = null
            wifiLock?.release()
            wifiLock = null
        }
    }
}
