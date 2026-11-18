package personal.undertone.player

import android.content.Context
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.json.JSONObject

object Engine {
    private var configured = false
    @Synchronized private fun initialize(context: Context) {
        if (configured) return
        if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
        Python.getInstance().getModule("android_bridge").callAttr("configure", context.filesDir.path, context.cacheDir.path)
        configured = true
    }

    fun reply(context: Context, operation: String, args: String): String {
        initialize(context)
        return Python.getInstance().getModule("android_bridge").callAttr("handle", operation, args).toString()
    }

    fun openPhoneDiscovery(context: Context, name: String): PyObject {
        initialize(context)
        return Python.getInstance().getModule("device_sync").callAttr("PhonePresence", name)
    }

    fun call(context: Context, operation: String, args: JSONObject): JSONObject {
        val response = JSONObject(reply(context, operation, args.toString()))
        if (response.has("error")) throw IllegalArgumentException(response.getString("error"))
        return response.getJSONObject("data")
    }
}
