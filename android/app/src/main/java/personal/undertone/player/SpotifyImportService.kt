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

open class SpotifyImportService : Service() {
    companion object {
        const val OPEN_IMPORT = "personal.undertone.player.OPEN_SPOTIFY_IMPORT"
        @Volatile var active = false
            private set
        @Volatile private var downloadActive = false
        fun isActive(operation: String) = if (operation.startsWith("download_job_")) downloadActive else active
        private data class Request(val args: String, val reply: (String) -> Unit)
        private val callbacks = ConcurrentHashMap<String, Request>()
        private val commands = Executors.newSingleThreadExecutor()
        // A replacement service must wait for an older service's in-flight lookup.
        private val importWorker = Executors.newSingleThreadExecutor()
        private val downloadWorker = Executors.newSingleThreadExecutor()

        fun command(context: Context, operation: String, args: String, respond: (String) -> Unit) {
            val key = UUID.randomUUID().toString()
            callbacks[key] = Request(args, respond)
            try {
                val service = if (operation.startsWith("download_job_")) DownloadService::class.java else SpotifyImportService::class.java
                val intent = Intent(context, service).setAction(operation).putExtra("key", key)
                if (operation.endsWith("_pause")) context.startService(intent) else context.startForegroundService(intent)
            } catch (error: RuntimeException) {
                callbacks.remove(key)?.reply?.invoke(failure(error))
            }
        }

        private fun failure(error: Exception): String =
            JSONObject().put("error", error.message ?: "Could not run the Spotify import.").toString()
    }

    protected open val download = false
    private val prefix get() = if (download) "download_job_" else "spotify_job_"
    private val channel get() = if (download) "music_downloads" else "spotify_import"
    private val notificationId get() = if (download) 38 else 37
    private val startTitle get() = if (download) R.string.song_downloads else R.string.spotify_import
    private val matching get() = if (download) downloadWorker else importWorker

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
        if (download) downloadActive = true else active = true
        notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(NotificationChannel(channel, getString(startTitle), NotificationManager.IMPORTANCE_LOW))
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Undertone:$prefix")
            .apply { setReferenceCounted(false) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStart = startId
        val ticket = ++generation
        commandPending = true
        val operation = intent?.action ?: prefix + "status"
        val request = intent?.getStringExtra("key")?.let(callbacks::remove)
        val args = JSONObject(request?.args ?: intent?.getStringExtra("args") ?: "{}")
        val respond = request?.reply
        if (!foreground) {
            if (args.has("language")) current.put("language", args.optString("language"))
            try {
                startForeground(notificationId, notification(current))
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
                runCatching { Engine.call(this, prefix + "status", JSONObject()) }.getOrNull()
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
                Engine.call(this, prefix + "step", args)
            } catch (_: Exception) {
                runCatching { Engine.call(this, prefix + "pause", args.put("reason", "error")) }.getOrNull()
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
            notifications.notify(notificationId, notification(state))
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
            "paused" -> if (download) R.string.downloads_paused else R.string.spotify_paused
            "done" -> if (download) R.string.downloads_finished else R.string.spotify_finished
            else -> startTitle
        }
        val text = when {
            state.optString("reason") == "offline" -> labels.getString(R.string.spotify_offline)
            total > 0 -> labels.getString(if (download) R.string.downloads_progress else R.string.spotify_progress, checked, total)
            else -> labels.getString(if (download) R.string.song_downloads else R.string.spotify_starting)
        }
        val immutable = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(this, notificationId,
            Intent(this, MainActivity::class.java).apply { if (!download) action = OPEN_IMPORT }, immutable)
        val builder = Notification.Builder(this, channel).setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(labels.getString(title)).setContentText(text).setContentIntent(open)
            .setCategory(Notification.CATEGORY_PROGRESS).setOnlyAlertOnce(true).setOngoing(running)
            .setAutoCancel(!running).setShowWhen(false)
        if (running) {
            builder.setProgress(total, checked, total == 0)
            if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            if (state.optString("jobId").isNotEmpty()) {
                val pause = Intent(this, javaClass).setAction(prefix + "pause")
                    .putExtra("args", JSONObject().put("jobId", state.getString("jobId")).toString())
                builder.addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause,
                    labels.getString(R.string.playback_pause), PendingIntent.getService(this, notificationId, pause, immutable)).build())
            }
        }
        return builder.build()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        closed = true
        val jobId = current.optString("jobId")
        if (jobId.isNotEmpty()) commands.execute {
            runCatching { Engine.call(this, prefix + "pause", JSONObject().put("jobId", jobId).put("reason", "timeout")) }
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        closed = true
        if (download) downloadActive = false else active = false
        if (wakeLock.isHeld) wakeLock.release()
        super.onDestroy()
    }
}

class DownloadService : SpotifyImportService() {
    override val download = true
}
