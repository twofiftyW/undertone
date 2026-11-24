package personal.undertone.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.UUID
import java.util.Locale

// Keep the shuffle order by occurrence so preparing a track and advancing select the same entry.
internal class PlaybackOrder {
    private var keys = emptyList<String>()
    private var shuffled = emptyList<String>()

    fun update(queueKeys: List<String>, activeIndex: Int, shuffle: Boolean) {
        keys = queueKeys
        if (!shuffle || activeIndex !in keys.indices) {
            shuffled = emptyList()
            return
        }
        val added = keys.toMutableSet()
        val kept = shuffled.filterTo(mutableListOf(), added::remove)
        if (added.remove(keys[activeIndex])) kept.add(keys[activeIndex])
        shuffled = kept + added.shuffled()
    }

    fun next(index: Int, direction: Int, ended: Boolean, repeat: String): Int {
        if (index !in keys.indices) return -1
        if (ended && repeat == "one") return index
        val ordered = shuffled.isNotEmpty()
        val size = if (ordered) shuffled.size else keys.size
        val position = if (ordered) shuffled.indexOf(keys[index]) else index
        val candidate = position + direction
        val next = when {
            candidate in 0 until size -> candidate
            repeat == "all" -> (candidate + size) % size
            else -> return -1
        }
        return if (ordered) keys.indexOf(shuffled[next]) else next
    }
}

class PlaybackService : Service() {
    companion object {
        @Volatile var running = false
        @Volatile var snapshot = "{\"index\":-1,\"playing\":false,\"loading\":false,\"position\":0,\"duration\":0}"
        @Volatile var queueSnapshot = "{\"tracks\":[],\"index\":-1}"
        private val pendingQueues = LinkedHashMap<String, String>()
        @Synchronized fun queueRequest(payload: String): String {
            val id = UUID.randomUUID().toString()
            pendingQueues[id] = payload
            while (pendingQueues.size > 32) pendingQueues.remove(pendingQueues.keys.first())
            return id
        }
        @Synchronized fun takeQueue(id: String): String? = pendingQueues.remove(id)
        private const val CHANNEL = "undertone_playback"
        private const val NOTIFICATION = 14
        private const val PRELOAD_WINDOW_MS = 20_000L
        private val MONOCHROME_ID = Regex("[0-9]{17,20}")
        private val AUDIUS_ID = Regex("[A-Za-z0-9]{1,100}")
    }

    // The same load can move from the queue to the foreground while it is still resolving or buffering.
    private class TrackLoad(val key: String) {
        var media: MediaPlayer? = null
        var streaming = false
        var ready = false
        var failed = false
    }

    private var tracks = JSONArray()
    private var index = -1
    private var activeLoad: TrackLoad? = null
    private var nextLoad: TrackLoad? = null
    private val player get() = activeLoad?.media
    private val prepared get() = activeLoad?.ready == true
    private val loading get() = activeLoad?.ready == false
    private var wantsPlay = true
    private var shuffle = false
    private val playbackOrder = PlaybackOrder()
    private var repeat = "off"
    private var volume = 0.8f
    private var error = ""
    private var resumeAfterFocus = false
    private var sessionId = ""
    private var language = "en"
    private var serial = 0
    private var playedAt = 0L
    private var handoffs = 0
    private var duck = 1f
    private val workers = Executors.newFixedThreadPool(2)
    private val handler = Handler(Looper.getMainLooper())
    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private lateinit var session: MediaSession
    private lateinit var audioManager: AudioManager
    private lateinit var focusRequest: AudioFocusRequest
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { pause() }
    }

    private val ticker = object : Runnable {
        override fun run() { refresh(false); handler.postDelayed(this, 250) }
    }

    override fun onCreate() {
        super.onCreate()
        running = true
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Music playback", NotificationManager.IMPORTANCE_LOW))
        audioManager = getSystemService(AudioManager::class.java)
        focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes).setOnAudioFocusChangeListener { change ->
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS -> { resumeAfterFocus = false; pause(false) }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { resumeAfterFocus = isPlaying(); pause(false) }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> { duck = 0.2f; applyVolume() }
                AudioManager.AUDIOFOCUS_GAIN -> {
                    duck = 1f; applyVolume()
                    if (resumeAfterFocus) { resumeAfterFocus = false; play() }
                }
            }
        }.build()
        session = MediaSession(this, "Undertone")
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() { play() }
            override fun onPause() { pause() }
            override fun onSkipToNext() { advance(1) }
            override fun onSkipToPrevious() { previous() }
            override fun onSeekTo(position: Long) { seek(position) }
            override fun onStop() { stopSelf() }
        })
        session.setSessionActivity(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        session.isActive = true
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        handler.post(ticker)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) { stopSelf(); return START_NOT_STICKY }
        try {
            val value = intent.getStringExtra("value") ?: ""
            when (intent.action) {
                "load", "replace" -> {
                    val pending = takeQueue(intent.getStringExtra("request") ?: "")
                    if (pending != null) {
                        val payload = JSONObject(pending)
                        val incoming = payload.getJSONArray("tracks")
                        require(incoming.length() in 1..20000)
                        if (intent.action == "load") {
                            tracks = incoming
                            index = payload.optInt("index", 0)
                            require(index in 0 until tracks.length())
                            sessionId = payload.optString("session", "")
                            language = if (payload.optString("language") == "ru") "ru" else "en"
                            shuffle = payload.optBoolean("shuffle", false)
                            updateOrder()
                            repeat = payload.optString("repeat", "off")
                            volume = payload.optDouble("volume", 0.8).toFloat().coerceIn(0f, 1f)
                            startForeground(NOTIFICATION, notification())
                            loadTrack()
                        } else if (payload.optString("session", "") == sessionId) {
                            val activeKey = trackKey(index)
                            tracks = incoming
                            val activeIndex = (0 until tracks.length()).firstOrNull { trackKey(it) == activeKey }
                            index = activeIndex ?: payload.optInt("index", 0).coerceIn(0, tracks.length() - 1)
                            shuffle = payload.optBoolean("shuffle", shuffle)
                            updateOrder()
                            repeat = payload.optString("repeat", repeat)
                            if (activeIndex == null) loadTrack()
                        }
                        publishQueue()
                    }
                }
                "toggle" -> if (isPlaying() || loading && wantsPlay) pause() else play()
                "next" -> advance(1)
                "previous" -> previous()
                "seek" -> seek(((value.toDoubleOrNull() ?: 0.0) * 1000).toLong())
                "volume" -> { volume = (value.toFloatOrNull() ?: volume).coerceIn(0f, 1f); applyVolume() }
                "shuffle" -> { shuffle = value == "true"; updateOrder() }
                "repeat" -> { repeat = if (value in setOf("off", "one", "all")) value else "off" }
                "language" -> language = if (value == "ru") "ru" else "en"
                "stop" -> { stopSelf(); return START_NOT_STICKY }
            }
            refresh()
        } catch (_: Exception) { fail("This track couldn’t start. Try another song.") }
        return START_NOT_STICKY
    }

    private fun validSource(value: String): Boolean {
        val uri = Uri.parse(value)
        if (uri.scheme == "https") return uri.host == "tracks.monochrome.st" || uri.host?.endsWith(".googlevideo.com") == true || uri.host == "discoveryprovider.audius.co"
        if (uri.scheme != null) return false
        val file = File(value)
        return listOf("audio", "downloads").any { file.canonicalPath.startsWith(File(filesDir, it).canonicalPath + File.separator) } && file.isFile
    }

    private fun loadTrack(autoplay: Boolean = true) {
        if (index < 0 || index >= tracks.length()) return
        clearNext()
        player?.release()
        val load = TrackLoad(trackKey(index))
        activeLoad = load
        beginTrack(autoplay)
        resolveTrack(load, tracks.getJSONObject(index))
        refresh()
    }

    private fun beginTrack(autoplay: Boolean) {
        wantsPlay = autoplay
        error = ""
        serial++
        playedAt = 0
        metadata()
        publishQueue()
    }

    private fun playbackUri(track: JSONObject, offlineOnly: Boolean): String? {
        val id = track.optString("remoteId")
        val source = track.optString("source")
        if (source == "audius" && AUDIUS_ID.matches(id)) {
            return if (offlineOnly) null else "https://discoveryprovider.audius.co/v1/tracks/$id/stream?app_name=UndertonePersonal"
        }
        if (source == "monochrome" && MONOCHROME_ID.matches(id)) {
            // An existing download still goes through the engine's complete-file and format checks.
            if (!File(filesDir, "downloads/$id.flac").isFile) {
                return if (offlineOnly) null else "https://tracks.monochrome.st/track/$id"
            }
        }
        val result = Engine.call(applicationContext, "resolve_track", JSONObject().put("track", track).put("offlineOnly", offlineOnly))
        return if (result.isNull("url")) null else result.getString("url")
    }

    private fun resolveTrack(load: TrackLoad, track: JSONObject, offlineOnly: Boolean = false) {
        workers.execute {
            try {
                val uri = playbackUri(track, offlineOnly)
                if (uri == null) { handler.post { if (load === nextLoad) load.failed = true }; return@execute }
                require(validSource(uri))
                handler.post {
                    if (load !== activeLoad && load !== nextLoad) return@post
                    if (load === nextLoad && uri.startsWith("https://") && connectivity?.activeNetwork == null) { clearNext(); return@post }
                    try { prepareSource(load, uri) }
                    catch (_: Exception) { loadFailed(load, "This audio stream couldn’t start. Try another recording.") }
                }
            } catch (failure: Exception) {
                handler.post { loadFailed(load, failure.message ?: "This recording is unavailable. Check your connection and retry.") }
            }
        }
    }

    private fun prepareSource(load: TrackLoad, uri: String) {
        val media = newPlayer(load)
        load.media = media
        load.streaming = uri.startsWith("https://")
        if (load === nextLoad) player?.audioSessionId?.takeIf { it > 0 }?.let { media.audioSessionId = it }
        media.setOnPreparedListener {
            if (load !== activeLoad && load !== nextLoad) return@setOnPreparedListener
            load.ready = true
            applyVolume()
            if (load === activeLoad) {
                if (wantsPlay) play() else refresh()
            } else {
                // The completion listener can start this same player if Android cannot link the pair.
                try { player?.setNextMediaPlayer(media) } catch (_: IllegalStateException) { }
                refresh(false)
            }
        }
        source(media, uri)
        media.prepareAsync()
    }

    private fun isPlaying(): Boolean = try { prepared && player?.isPlaying == true } catch (_: Exception) { false }
    private fun position(): Long = try { if (prepared) player?.currentPosition?.toLong() ?: 0 else 0 } catch (_: Exception) { 0 }
    private fun duration(): Long = try { if (prepared) player?.duration?.toLong()?.coerceAtLeast(0) ?: 0 else 0 } catch (_: Exception) { 0 }

    private fun play() {
        wantsPlay = true
        if (!prepared) {
            if (!loading && index >= 0) loadTrack()
            return
        }
        if (audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            player?.start()
            notePlaylist()
            refresh()
        } else { wantsPlay = false; refresh() }
    }

    private fun pause(abandonFocus: Boolean = true) {
        wantsPlay = false
        if (isPlaying()) player?.pause()
        if (abandonFocus) { resumeAfterFocus = false; audioManager.abandonAudioFocusRequest(focusRequest) }
        refresh()
    }

    private fun seek(position: Long) {
        if (prepared) player?.seekTo(position.coerceIn(0L, duration()), MediaPlayer.SEEK_CLOSEST)
        refresh()
    }

    private fun previous() { if (position() > 3000 || chooseNext(-1, false) < 0) seek(0) else advance(-1) }

    private fun advance(direction: Int, ended: Boolean = false) {
        if (tracks.length() == 0) return
        val next = chooseNext(direction, ended)
        if (next < 0) { if (ended) pause(); return }
        val autoplay = !ended || wantsPlay
        val upcoming = nextLoad
        if (upcoming != null && !upcoming.failed && upcoming.key == trackKey(next)) {
            val old = player
            try { old?.setNextMediaPlayer(null) } catch (_: IllegalStateException) { }
            nextLoad = null
            activeLoad = upcoming
            old?.release()
            index = next
            handoffs++
            beginTrack(autoplay)
            if (prepared) {
                if (wantsPlay && !isPlaying()) play()
                else if (wantsPlay) notePlaylist()
                else if (isPlaying()) player?.pause()
            }
            refresh()
            return
        }
        index = next
        try { loadTrack(autoplay) } catch (_: Exception) { fail("This track couldn’t start. Try another song.") }
    }

    private fun updateOrder() = playbackOrder.update((0 until tracks.length()).map(::trackKey), index, shuffle)

    private fun chooseNext(direction: Int, ended: Boolean) = playbackOrder.next(index, direction, ended, repeat)

    private fun trackKey(position: Int): String = tracks.optJSONObject(position)?.let { it.optString("queueKey", it.optString("id", "")) } ?: ""

    private fun publishQueue() { queueSnapshot = JSONObject().put("tracks", tracks).put("index", index).put("session", sessionId).toString() }

    private fun metadata() {
        val track = tracks.optJSONObject(index) ?: return
        session.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, track.optString("title", "Untitled")).putString(MediaMetadata.METADATA_KEY_ARTIST, track.optString("artist", "")).putLong(MediaMetadata.METADATA_KEY_DURATION, (track.optDouble("duration", 0.0) * 1000).toLong()).build())
    }

    private fun notePlaylist() {
        playedAt = System.currentTimeMillis()
        val id = tracks.optJSONObject(index)?.optString("playlistId", "") ?: ""
        if (id.isNotEmpty() && id != "null") getSharedPreferences("playlist-playback", MODE_PRIVATE).edit().putLong(id, playedAt).apply()
    }

    private fun applyVolume() {
        if (prepared) player?.setVolume(volume * duck, volume * duck)
        nextLoad?.takeIf { it.ready }?.media?.setVolume(volume * duck, volume * duck)
    }

    private fun source(target: MediaPlayer, uri: String) {
        if (uri.startsWith("https://")) target.setDataSource(this, Uri.parse(uri), mapOf("User-Agent" to "Undertone/${BuildConfig.VERSION_NAME}")) else target.setDataSource(uri)
    }

    private fun newPlayer(load: TrackLoad): MediaPlayer = MediaPlayer().apply {
        setAudioAttributes(attributes)
        setWakeMode(applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
        setVolume(volume * duck, volume * duck)
        setOnCompletionListener { if (player === this) advance(1, true) }
        setOnErrorListener { _, _, _ ->
            loadFailed(load, "This stream or file is unavailable. Try another song.")
            true
        }
    }

    private fun clearNext() {
        val upcoming = nextLoad ?: return
        nextLoad = null
        try { player?.setNextMediaPlayer(null) } catch (_: IllegalStateException) { }
        upcoming.media?.release()
    }

    private fun prepareNext(playing: Boolean, position: Long, duration: Long) {
        val playingStream = activeLoad?.streaming == true
        val inWindow = playing && (!playingStream || duration - position in 1L..PRELOAD_WINDOW_MS)
        val upcoming = chooseNext(1, true)
        val key = trackKey(upcoming)
        if (nextLoad?.key != key) clearNext()
        if (key.isEmpty() || upcoming == index || nextLoad != null || !inWindow) return
        val load = TrackLoad(key)
        nextLoad = load
        resolveTrack(load, tracks.getJSONObject(upcoming), !playingStream || connectivity?.activeNetwork == null)
    }

    private fun loadFailed(load: TrackLoad, message: String) {
        if (activeLoad === load) fail(message)
        else if (nextLoad === load) {
            try { player?.setNextMediaPlayer(null) } catch (_: IllegalStateException) { }
            load.media?.release()
            load.media = null
            load.ready = false
            // The foreground can retry this recording without reissuing a request on every tick.
            load.failed = true
        }
    }

    private fun fail(message: String) {
        clearNext()
        error = message
        player?.release()
        activeLoad = null
        wantsPlay = false
        audioManager.abandonAudioFocusRequest(focusRequest)
        refresh()
    }

    // Every notification uses MediaStyle and this active MediaSession. Media-session
    // notifications are exempt from POST_NOTIFICATIONS on Android 13+:
    // https://developer.android.com/develop/ui/views/notifications/notification-permission#exemptions
    @SuppressLint("NotificationPermission")
    private fun refresh(notify: Boolean = true) {
        val playing = isPlaying()
        val pos = position()
        val length = duration()
        prepareNext(playing, pos, length)
        val upcoming = nextLoad?.takeUnless { it.failed }
        snapshot = JSONObject().put("index", index).put("key", trackKey(index)).put("session", sessionId).put("serial", serial).put("playedAt", playedAt).put("nextKey", upcoming?.key.orEmpty()).put("nextPrepared", upcoming?.ready == true).put("handoffs", handoffs).put("playing", playing).put("loading", loading).put("position", pos / 1000.0).put("duration", length / 1000.0).put("shuffle", shuffle).put("repeat", repeat).put("error", error).toString()
        val state = if (loading) PlaybackState.STATE_BUFFERING else if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
        session.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP).setState(state, pos, if (playing) 1f else 0f).build())
        if (notify && index >= 0) getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
    }

    private fun notification(): Notification {
        val track = tracks.optJSONObject(index)
        val locale = Configuration(resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) }
        val localized = createConfigurationContext(locale)
        fun action(action: String) = PendingIntent.getService(this, action.hashCode(), Intent(this, PlaybackService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_music).setContentTitle(track?.optString("title") ?: getString(R.string.app_name)).setContentText(track?.optString("artist") ?: "").setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true).setOngoing(isPlaying()).addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, localized.getString(R.string.playback_previous), action("previous")).build()).addAction(Notification.Action.Builder(if (isPlaying()) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, localized.getString(if (isPlaying()) R.string.playback_pause else R.string.playback_play), action("toggle")).build()).addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, localized.getString(R.string.playback_next), action("next")).build()).setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2)).build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        clearNext()
        workers.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        player?.release()
        activeLoad = null
        audioManager.abandonAudioFocusRequest(focusRequest)
        session.isActive = false
        session.release()
        unregisterReceiver(noisyReceiver)
        stopForeground(STOP_FOREGROUND_REMOVE)
        running = false
        snapshot = "{\"index\":-1,\"playing\":false,\"loading\":false,\"position\":0,\"duration\":0}"
        queueSnapshot = "{\"tracks\":[],\"index\":-1}"
        super.onDestroy()
    }
}
