package personal.undertone.player

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class SpotifyImportService : Service() {
    companion object {
        const val OPEN_IMPORT = "personal.undertone.player.OPEN_SPOTIFY_IMPORT"
        private const val CHANNEL = "spotify_import"
        private const val NOTIFICATION = 37
        private const val PAUSE = "spotify_job_pause"
        private const val STATUS = "spotify_job_status"
        @Volatile var active = false
            private set
        private val callbacks = ConcurrentHashMap<String, (String) -> Unit>()
        private val commands = Executors.newSingleThreadExecutor()
        // A replacement service must wait for an older service's in-flight lookup.
        private val matching = Executors.newSingleThreadExecutor()

        fun command(context: Context, operation: String, args: String, respond: (String) -> Unit) {
            val key = UUID.randomUUID().toString()
            callbacks[key] = respond
            try {
                val intent = Intent(context, SpotifyImportService::class.java).setAction(operation)
                    .putExtra("key", key).putExtra("args", args)
                if (operation == PAUSE) context.startService(intent) else context.startForegroundService(intent)
            } catch (error: RuntimeException) {
                callbacks.remove(key)?.invoke(failure(error))
            }
        }

        private fun failure(error: Exception): String =
            JSONObject().put("error", error.message ?: "Could not run the Spotify import.").toString()
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var notifications: NotificationManager
    private lateinit var wakeLock: PowerManager.WakeLock
    private var current = JSONObject()
    private var latestStart = 0
    private var generation = 0
    private var commandPending = false
    private var inFlight = false
    private var foreground = false
    private var closed = false
    private var lastNotification = 0L
    private var lastWake = 0L

    override fun onCreate() {
        super.onCreate()
        active = true
        notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.spotify_import), NotificationManager.IMPORTANCE_LOW))
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Undertone:SpotifyImport")
            .apply { setReferenceCounted(false) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStart = startId
        val ticket = ++generation
        commandPending = true
        val operation = intent?.action ?: STATUS
        val args = JSONObject(intent?.getStringExtra("args") ?: "{}")
        val respond = intent?.getStringExtra("key")?.let(callbacks::remove)
        if (!foreground) {
            if (args.has("language")) current.put("language", args.optString("language"))
            try {
                startForeground(NOTIFICATION, notification(current))
                foreground = true
            } catch (error: RuntimeException) {
                respond?.invoke(failure(error))
                stopSelf(startId)
                return START_NOT_STICKY
            }
        }
        commands.execute {
            val state = try {
                Engine.call(this, operation, args).also {
                    respond?.invoke(JSONObject().put("data", it).toString())
                }
            } catch (error: Exception) {
                respond?.invoke(failure(error))
                runCatching { Engine.call(this, STATUS, JSONObject()) }.getOrNull()
            }
            main.post {
                if (!closed && ticket == generation) {
                    commandPending = false
                    observe(state)
                }
            }
        }
        return START_STICKY
    }

    private fun observe(state: JSONObject?) {
        current = state ?: JSONObject()
        if (current.optString("state") != "running") {
            // A pause is durable immediately. Keep the process alive until the
            // current group has journaled its results and final progress.
            if (inFlight && current.optString("state") == "paused") {
                updateNotification(current)
                return
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            foreground = false
            if (current.optInt("total") > 0) updateNotification(current)
            stopSelfResult(latestStart)
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (now - lastNotification >= 1000 || lastNotification == 0L) {
            updateNotification(current)
            lastNotification = now
        }
        if (!wakeLock.isHeld || now - lastWake >= 9 * 60_000L) {
            wakeLock.acquire(10 * 60_000L)
            lastWake = now
        }
        startNextBatch()
    }

    private fun startNextBatch() {
        if (closed || commandPending || inFlight || current.optString("state") != "running") return
        val ticket = generation
        val args = JSONObject().put("jobId", current.getString("jobId"))
        inFlight = true
        matching.execute {
            val next = try {
                Engine.call(this, "spotify_job_step", args)
            } catch (_: Exception) {
                runCatching { Engine.call(this, PAUSE, args.put("reason", "error")) }.getOrNull()
            }
            main.post {
                inFlight = false
                if (!closed) {
                    if (ticket == generation) observe(next)
                    else if (!commandPending) {
                        val settledPause = current.optString("state") == "paused" && next != null &&
                            next.optString("jobId") == current.optString("jobId") && next.optString("state") != "running"
                        observe(if (settledPause) next else current)
                    }
                }
            }
        }
    }

    private fun updateNotification(state: JSONObject) {
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            notifications.notify(NOTIFICATION, notification(state))
        }
    }

    private fun notification(state: JSONObject): Notification {
        val language = state.optString("language")
        val labels = if (language in setOf("ru", "en")) createConfigurationContext(
            Configuration(resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) }
        ) else this
        val status = state.optString("state")
        val checked = state.optInt("checked")
        val total = state.optInt("total")
        val running = status !in setOf("paused", "done", "idle")
        val title = when (status) {
            "paused" -> R.string.spotify_paused
            "done" -> R.string.spotify_finished
            else -> R.string.spotify_import
        }
        val text = when {
            state.optString("reason") == "offline" -> labels.getString(R.string.spotify_offline)
            total > 0 -> labels.getString(R.string.spotify_progress, checked, total)
            else -> labels.getString(R.string.spotify_starting)
        }
        val immutable = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(this, NOTIFICATION,
            Intent(this, MainActivity::class.java).setAction(OPEN_IMPORT), immutable)
        val builder = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(labels.getString(title)).setContentText(text).setContentIntent(open)
            .setCategory(Notification.CATEGORY_PROGRESS).setOnlyAlertOnce(true).setOngoing(running)
            .setAutoCancel(!running).setShowWhen(false)
        if (running) {
            builder.setProgress(total, checked, total == 0)
            if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            if (state.optString("jobId").isNotEmpty()) {
                val pause = Intent(this, SpotifyImportService::class.java).setAction(PAUSE)
                    .putExtra("args", JSONObject().put("jobId", state.getString("jobId")).toString())
                builder.addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause,
                    labels.getString(R.string.playback_pause), PendingIntent.getService(this, NOTIFICATION, pause, immutable)).build())
            }
        }
        return builder.build()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        closed = true
        val jobId = current.optString("jobId")
        if (jobId.isNotEmpty()) commands.execute {
            runCatching { Engine.call(this, PAUSE, JSONObject().put("jobId", jobId).put("reason", "timeout")) }
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        closed = true
        active = false
        if (wakeLock.isHeld) wakeLock.release()
        super.onDestroy()
    }
}
