package personal.undertone.player

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class AppUpdates(private val activity: MainActivity) {
    private var afterPermission: (() -> Unit)? = null

    fun request(args: String, callback: (String) -> Unit) {
        val options = runCatching { JSONObject(args) }.getOrElse {
            callback(error("Unknown update request."))
            return
        }
        val operation = options.optString("operation")
        val value = options.optString("value")
        if (operation in setOf("status", "check")) {
            worker.execute {
                if (operation == "status" && !installing.get()) File(activity.cacheDir, "undertone-update.apk").delete()
                callback(runCatching { Engine.update(activity, operation, value) }.getOrElse {
                    error("Could not check for updates. Try again.")
                })
            }
        } else if (operation == "install") {
            activity.runOnUiThread { accept(value, callback) }
        } else {
            callback(error("Unknown update request."))
        }
    }

    private fun accept(version: String, callback: (String) -> Unit) {
        if (!installing.compareAndSet(false, true)) {
            callback(error("An update is already being installed."))
            return
        }
        if (activity.packageManager.canRequestPackageInstalls()) {
            download(version, callback)
            return
        }
        afterPermission = {
            if (activity.packageManager.canRequestPackageInstalls()) download(version, callback)
            else fail(callback, "Allow Undertone to install app updates in Android settings.")
        }
        try {
            @Suppress("DEPRECATION")
            activity.startActivityForResult(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                INSTALL_PERMISSION,
            )
        } catch (_: Exception) {
            afterPermission = null
            fail(callback, "Allow Undertone to install app updates in Android settings.")
        }
    }

    fun permissionResult() {
        val next = afterPermission
        afterPermission = null
        next?.invoke()
    }

    fun destroy() {
        if (afterPermission != null) installing.set(false)
        afterPermission = null
    }

    private fun download(version: String, callback: (String) -> Unit) = worker.execute {
        val context = activity.applicationContext
        try {
            val apk = File(context.cacheDir, "undertone-update.apk")
            try {
                val response = JSONObject(Engine.update(context, "install", version, apk.path))
                if (response.has("error")) {
                    fail(callback, response.getString("error"))
                } else {
                    commit(context, apk, version, callback)
                }
            } finally {
                apk.delete()
            }
        } catch (_: Exception) {
            fail(callback, "Android couldn’t install the update. Try again.")
        }
    }

    @Suppress("DEPRECATION")
    private fun commit(context: Context, apk: File, version: String, callback: (String) -> Unit) {
        val manager = context.packageManager
        val packageInfo = requireNotNull(manager.getPackageArchiveInfo(apk.path, 0))
        require(packageInfo.packageName == context.packageName && packageInfo.versionName == version)
        val versionCode = if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else packageInfo.versionCode.toLong()
        require(versionCode > BuildConfig.VERSION_CODE)
        val installer = manager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { output ->
                    apk.inputStream().use { it.copyTo(output) }
                    session.fsync(output)
                }
                check(apk.delete()) // The installer now owns its copy.
                callbacks[sessionId] = callback
                val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val result = PendingIntent.getBroadcast(context, sessionId, Intent(context, UpdateInstallReceiver::class.java),
                    mutable or PendingIntent.FLAG_UPDATE_CURRENT)
                session.commit(result.intentSender)
            }
        } catch (error: Exception) {
            callbacks.remove(sessionId)
            runCatching { installer.abandonSession(sessionId) }
            throw error
        }
    }

    companion object {
        const val INSTALL_PERMISSION = 43
        private val worker = Executors.newSingleThreadExecutor()
        private val installing = AtomicBoolean(false)
        private val callbacks = ConcurrentHashMap<Int, (String) -> Unit>()

        private fun error(message: String) = JSONObject().put("error", message).toString()
        private fun fail(callback: (String) -> Unit, message: String) {
            installing.set(false)
            callback(error(message))
        }

        @Suppress("DEPRECATION")
        fun handleResult(context: Context, intent: Intent) {
            val session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
            val callback = callbacks[session] ?: return
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                    if (confirmation != null && runCatching {
                            context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }.isSuccess) return
                    runCatching { context.packageManager.packageInstaller.abandonSession(session) }
                    fail(callback, "Open Undertone to confirm the Android update.")
                }
                PackageInstaller.STATUS_SUCCESS -> {
                    installing.set(false)
                    callback(JSONObject().put("data", JSONObject().put("ready", true)).toString())
                }
                PackageInstaller.STATUS_FAILURE_ABORTED -> fail(callback, "Update installation was canceled.")
                else -> fail(callback, "Android couldn’t install the update. Try again.")
            }
            callbacks.remove(session)
        }
    }
}

class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = AppUpdates.handleResult(context, intent)
}
