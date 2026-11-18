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
    }

    private var tracks = JSONArray()
    private var index = -1
    private var player: MediaPlayer? = null
    private var prepared = false
    private var loading = false
    private var wantsPlay = true
    private var shuffle = false
    private val playbackOrder = PlaybackOrder()
    private var repeat = "off"
    private var volume = 0.8f
    private var error = ""
    private var resumeAfterFocus = false
    private var generation = 0
    private var sessionId = ""
    private var language = "en"
    private var serial = 0
    private var playedAt = 0L
    private var nextPlayer: MediaPlayer? = null
    private var nextReady = false
    private var nextIndex = -1
    private var nextKey = ""
    private var nextTicket = 0
    private var handoffs = 0
    private var duck = 1f
    private val workers = Executors.newFixedThreadPool(2)
    private val handler = Handler(Looper.getMainLooper())
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
                            nextIndex = (0 until tracks.length()).firstOrNull { trackKey(it) == nextKey } ?: -1
                            if (activeIndex == null) loadTrack() else prepareNext()
                        }
                        publishQueue()
                    }
                }
                "toggle" -> if (isPlaying() || loading && wantsPlay) pause() else play()
                "next" -> advance(1)
                "previous" -> previous()
                "seek" -> seek(((value.toDoubleOrNull() ?: 0.0) * 1000).toLong())
                "volume" -> { volume = (value.toFloatOrNull() ?: volume).coerceIn(0f, 1f); applyVolume() }
                "shuffle" -> { shuffle = value == "true"; updateOrder(); clearNext(); prepareNext() }
                "repeat" -> { repeat = if (value in setOf("off", "one", "all")) value else "off"; clearNext(); prepareNext() }
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

    private fun loadTrack() {
        if (index < 0 || index >= tracks.length()) return
        clearNext()
        player?.release()
        player = null
        prepared = false
        loading = true
        wantsPlay = true
        error = ""
        serial++
        playedAt = 0
        val track = tracks.getJSONObject(index)
        metadata()
        val ticket = ++generation
        workers.execute {
            try {
                val result = Engine.call(applicationContext, "resolve_track", JSONObject().put("track", track))
                val uri = result.getString("url")
                require(validSource(uri))
                handler.post { if (ticket == generation && running) { try { prepareSource(uri) } catch (_: Exception) { fail("This audio stream couldn’t start. Try another recording.") } } }
            } catch (error: Exception) {
                handler.post { if (ticket == generation && running) fail(error.message ?: "This recording is unavailable. Check your connection and retry.") }
            }
        }
        publishQueue()
        refresh()
    }

    private fun prepareSource(uri: String) {
        val next = newPlayer()
        player = next
        next.setOnPreparedListener {
            if (player !== next) return@setOnPreparedListener
            prepared = true
            loading = false
            if (wantsPlay) play()
            prepareNext()
            refresh()
        }
        source(next, uri)
        next.prepareAsync()
        refresh()
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
        if (next == nextIndex && nextReady && nextPlayer != null) {
            val old = player
            val promoted = nextPlayer!!
            player = promoted; nextPlayer = null; nextReady = false
            index = next; nextIndex = -1; nextKey = ""; nextTicket++
            prepared = true; loading = false; error = ""; serial++; handoffs++
            try { old?.setNextMediaPlayer(null) } catch (_: IllegalStateException) { }
            old?.release()
            metadata(); publishQueue()
            if (!ended) { wantsPlay = true; play() }
            else if (wantsPlay) notePlaylist()
            else if (promoted.isPlaying) promoted.pause()
            prepareNext(); refresh()
            return
        }
        index = next
        try { loadTrack() } catch (_: Exception) { fail("This track couldn’t start. Try another song.") }
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
        player?.setVolume(volume * duck, volume * duck)
        nextPlayer?.setVolume(volume * duck, volume * duck)
    }

    private fun source(target: MediaPlayer, uri: String) {
        if (uri.startsWith("https://")) target.setDataSource(this, Uri.parse(uri), mapOf("User-Agent" to "Undertone/${BuildConfig.VERSION_NAME}")) else target.setDataSource(uri)
    }

    private fun newPlayer(): MediaPlayer = MediaPlayer().apply {
        setAudioAttributes(attributes)
        setWakeMode(applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
        setVolume(volume * duck, volume * duck)
        setOnCompletionListener { if (player === this) advance(1, true) }
        setOnErrorListener { _, _, _ ->
            if (player === this) fail("This stream or file is unavailable. Try another song.")
            else if (nextPlayer === this) clearNext()
            true
        }
    }

    private fun clearNext() {
        nextTicket++
        try { player?.setNextMediaPlayer(null) } catch (_: IllegalStateException) { }
        nextPlayer?.release(); nextPlayer = null; nextReady = false
        nextIndex = -1; nextKey = ""
    }

    private fun prepareNext() {
        val current = player ?: return
        if (!prepared) return
        val upcoming = chooseNext(1, true)
        if (upcoming < 0) { clearNext(); return }
        val key = trackKey(upcoming)
        if (key == nextKey && nextIndex >= 0) { nextIndex = upcoming; return }
        clearNext()
        nextIndex = upcoming; nextKey = key
        val ticket = nextTicket
        val track = tracks.getJSONObject(upcoming)
        workers.execute {
            try {
                val uri = Engine.call(applicationContext, "resolve_track", JSONObject().put("track", track)).getString("url")
                require(validSource(uri))
                handler.post {
                    if (ticket != nextTicket || player !== current || !running) return@post
                    try {
                        val staged = newPlayer()
                        nextPlayer = staged
                        if (current.audioSessionId > 0) staged.audioSessionId = current.audioSessionId
                        staged.setOnPreparedListener {
                            if (ticket != nextTicket || nextPlayer !== staged || player !== current) return@setOnPreparedListener
                            try {
                                current.setNextMediaPlayer(staged)
                                nextReady = true
                                refresh(false)
                            } catch (_: IllegalStateException) { clearNext() }
                        }
                        source(staged, uri)
                        staged.prepareAsync()
                    } catch (_: Exception) { clearNext() }
                }
            } catch (_: Exception) { handler.post { if (ticket == nextTicket) clearNext() } }
        }
    }

    private fun fail(message: String) {
        clearNext()
        error = message
        player?.release()
        player = null
        prepared = false
        loading = false
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
        snapshot = JSONObject().put("index", index).put("key", trackKey(index)).put("session", sessionId).put("serial", serial).put("playedAt", playedAt).put("nextKey", nextKey).put("nextPrepared", nextReady).put("handoffs", handoffs).put("playing", playing).put("loading", loading).put("position", pos / 1000.0).put("duration", duration() / 1000.0).put("shuffle", shuffle).put("repeat", repeat).put("error", error).toString()
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
        return Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_music).setContentTitle(track?.optString("title") ?: "Undertone").setContentText(track?.optString("artist") ?: "").setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true).setOngoing(isPlaying()).addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, localized.getString(R.string.playback_previous), action("previous")).build()).addAction(Notification.Action.Builder(if (isPlaying()) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, localized.getString(if (isPlaying()) R.string.playback_pause else R.string.playback_play), action("toggle")).build()).addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, localized.getString(R.string.playback_next), action("next")).build()).setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2)).build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        clearNext()
        generation++
        workers.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        player?.release()
        player = null
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
