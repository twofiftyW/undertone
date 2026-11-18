package personal.undertone.player

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Runs against the actual Android Python runtime and native audio decoder.
class EngineInstrumentation : Instrumentation() {
    private var arguments = Bundle()
    override fun onCreate(args: Bundle?) { super.onCreate(args); arguments = args ?: Bundle(); start() }
    override fun onStart() {
        Thread {
            val results = Bundle()
            try {
                val context = targetContext
                if (arguments.getString("ui_only") == "true") {
                    val track = JSONObject().put("id", "local:swipe-fixture").put("fileId", "a".repeat(64) + ".wav").put("title", "Swipe fixture").put("source", "local").put("artist", "Your files")
                    val library = JSONObject().put("version", 1).put("tracks", JSONObject().put("local:swipe-fixture", track))
                        .put("liked", JSONArray()).put("recent", JSONArray()).put("imports", JSONArray())
                        .put("playlists", JSONArray().put(JSONObject().put("id", "gesture").put("name", "Gesture test").put("trackIds", JSONArray().put("local:swipe-fixture"))))
                    check(!JSONObject(DeviceBridge(context) { _, _ -> }.saveLibrary(library.toString())).has("error"))
                    val activity = startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    checkLanguageAndSwipe(activity, "Swipe fixture")
                    runOnMainSync { activity.finish() }
                    results.putString("result", "PASS: Android Russian UI persistence and swipe-to-queue")
                    finish(Activity.RESULT_OK, results)
                    return@Thread
                }
                val profile = Engine.call(context, "music", JSONObject().put("operation", "album").put("args", JSONObject().put("id", "mono:album:159607676672839680")))
                check(profile.getJSONArray("tracks").length() == 9) { "Android album lookup returned incomplete tracks" }
                val activity = startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                val bridge = PlaybackBridge(context)
                val sample = JSONObject().put("id", "monochrome:159277913216937984").put("remoteId", "159277913216937984").put("source", "monochrome").put("kind", "song").put("title", "Close Eyes").put("artist", "DVRST").put("duration", 132)
                fun queue() = JSONObject().put("tracks", org.json.JSONArray().put(sample)).put("index", 0).put("volume", 0).toString()
                fun waitFor(message: String, condition: (JSONObject) -> Boolean) {
                    val deadline = System.currentTimeMillis() + 45000
                    do {
                        val state = JSONObject(PlaybackService.snapshot)
                        check(state.optString("error").isEmpty()) { state.optString("error") }
                        if (condition(state)) return
                        Thread.sleep(100)
                    } while (System.currentTimeMillis() < deadline)
                    error(message + ": " + PlaybackService.snapshot)
                }
                bridge.loadQueue(queue())
                waitFor("Android streaming did not start") { it.optBoolean("playing") && it.optDouble("position") > 1 }
                runOnMainSync { activity.moveTaskToBack(true) }
                Thread.sleep(14000)
                check(JSONObject(PlaybackService.snapshot).optDouble("position") > 12) { "The live stream stopped early: " + PlaybackService.snapshot }
                bridge.command("toggle", "")
                waitFor("Pause did not reach the Android service") { !it.optBoolean("playing") && !it.optBoolean("loading") }
                bridge.command("seek", "30")
                waitFor("Android seek did not complete") { it.optDouble("position") in 29.0..31.0 }
                bridge.command("stop", "")
                Thread.sleep(500)
                val address = arguments.getString("address") ?: error("Missing test PC address")
                val code = arguments.getString("code") ?: error("Missing test pairing code")
                Engine.call(context, "link_pair", JSONObject().put("address", address).put("code", code))
                val copied = Engine.call(context, "link_pull", JSONObject().put("audio", true))
                check(copied.getInt("copied") == 1) { "Android did not copy the saved song" }
                val library = copied.getJSONObject("library")
                check(library.getJSONArray("playlists").length() == 1)
                val track = library.getJSONObject("tracks").getJSONObject("monochrome:159277913216937984")
                val offline = Engine.call(context, "resolve_track", JSONObject().put("track", track))
                check(offline.getBoolean("offline"))
                val file = File(offline.getString("url"))
                check(file.length() == 12924173L)
                context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                Thread.sleep(1000)
                bridge.loadQueue(queue())
                waitFor("Offline Android playback did not start") { it.optBoolean("playing") && it.optDouble("position") > 1 }
                check(JSONObject(PlaybackService.snapshot).optDouble("duration") in 131.0..134.0)
                bridge.command("stop", "")
                check(Engine.call(context, "link_pull", JSONObject().put("audio", true)).getInt("copied") == 0)
                val storage = DeviceBridge(context) { _, _ -> }
                library.getJSONArray("playlists").getJSONObject(0).put("pinnedAt", 123L)
                check(!JSONObject(storage.saveLibrary(library.toString())).has("error"))
                fun fixture(letter: Char): JSONObject {
                    val filename = letter.toString().repeat(64) + ".wav"
                    val samples = 8000 * 2 * 3
                    val wav = ByteBuffer.allocate(44 + samples).order(ByteOrder.LITTLE_ENDIAN)
                    wav.put("RIFF".toByteArray()).putInt(36 + samples).put("WAVEfmt ".toByteArray()).putInt(16)
                    wav.putShort(1).putShort(1).putInt(8000).putInt(16000).putShort(2).putShort(16)
                    wav.put("data".toByteArray()).putInt(samples)
                    File(context.filesDir, "audio").apply { mkdirs() }.resolve(filename).writeBytes(wav.array())
                    return JSONObject().put("id", "local:$letter").put("fileId", filename).put("source", "local").put("title", "Fixture $letter").put("duration", 3).put("queueKey", "fixture-$letter").put("playlistId", "pc-test")
                }
                val a = fixture('a'); val b = fixture('b'); val c = fixture('c')
                fun payload(index: Int, vararg songs: JSONObject): String = JSONObject().put("tracks", org.json.JSONArray(songs.toList())).put("index", index).put("session", "queue-test").put("volume", 0).put("shuffle", false).put("repeat", "off").toString()
                bridge.loadQueue(payload(0, a, b, c))
                waitFor("Next Android song was not prepared") { it.optString("session") == "queue-test" && it.optBoolean("nextPrepared") && it.optString("nextKey") == "fixture-b" }
                val startedAt = JSONObject(PlaybackService.snapshot).optDouble("position")
                bridge.replaceQueue(payload(1, b, a, c))
                waitFor("Reorder restarted or replaced the playing song") { it.optInt("index") == 1 && it.optString("key") == "fixture-a" && it.optBoolean("nextPrepared") && it.optString("nextKey") == "fixture-c" }
                check(JSONObject(PlaybackService.snapshot).optDouble("position") >= startedAt - 0.1)
                bridge.replaceQueue(payload(0, a, c, b))
                bridge.replaceQueue(payload(0, a, b, c))
                waitFor("Rapid queue edits lost their final order") { it.optInt("index") == 0 && it.optString("key") == "fixture-a" && it.optBoolean("nextPrepared") && it.optString("nextKey") == "fixture-b" }
                bridge.command("toggle", "")
                waitFor("Queue pause failed") { !it.optBoolean("playing") && !it.optBoolean("loading") }
                bridge.command("seek", "2.4")
                Thread.sleep(250)
                bridge.command("toggle", "")
                waitFor("Prepared Android handoff failed") { it.optString("key") == "fixture-b" && it.optBoolean("playing") && it.optInt("handoffs") >= 1 }
                val duplicate = JSONObject(c.toString()).put("queueKey", "extra-c")
                bridge.replaceQueue(payload(1, a, b, duplicate, c))
                waitFor("An added song was not prepared to play next") { it.optString("key") == "fixture-b" && it.optBoolean("nextPrepared") && it.optString("nextKey") == "extra-c" }
                bridge.command("next", "")
                waitFor("Skip did not use the prepared queue entry") { it.optString("key") == "extra-c" && it.optInt("index") == 2 && it.optBoolean("playing") && it.optInt("handoffs") >= 2 }
                bridge.command("repeat", "one")
                waitFor("Repeat did not prepare the same song") { it.optString("nextKey") == "extra-c" && it.optBoolean("nextPrepared") }
                val previousSerial = JSONObject(PlaybackService.snapshot).getInt("serial")
                bridge.command("seek", "2.6")
                waitFor("Repeat handoff did not advance its playback identity") { it.optInt("serial") > previousSerial && it.optString("key") == "extra-c" && it.optBoolean("playing") }
                bridge.command("stop", "")
                val savedPlaylist = JSONObject(storage.loadLibrary()).getJSONObject("data").getJSONArray("playlists").getJSONObject(0)
                check(savedPlaylist.getLong("pinnedAt") == 123L && savedPlaylist.getLong("lastPlayedAt") > 0L)
                checkLanguageAndSwipe(activity, track.getString("title"))
                runOnMainSync { activity.finish() }
                results.putString("result", "PASS: Android streaming/background/offline playback, PC copy, queue edits and handoffs, pins, Russian UI persistence, and swipe-to-queue")
                finish(Activity.RESULT_OK, results)
            } catch (error: Throwable) {
                results.putString("result", "FAIL: " + (error.message ?: error.javaClass.name))
                finish(Activity.RESULT_CANCELED, results)
            }
        }.start()
    }

    private fun checkLanguageAndSwipe(activity: Activity, title: String) {
        lateinit var web: WebView
        val origin = IntArray(2)
        runOnMainSync {
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
            web = (content.getChildAt(0) as ViewGroup).getChildAt(0) as WebView
            web.loadUrl("https://appassets.androidplatform.net/assets/index.html?ui-test")
        }
        fun js(expression: String): String {
            val done = CountDownLatch(1)
            var result = "null"
            runOnMainSync { web.evaluateJavascript(expression) { result = it; done.countDown() } }
            check(done.await(8, TimeUnit.SECONDS)) { "WebView did not answer" }
            return result
        }
        fun await(label: String, expression: String) {
            val end = SystemClock.uptimeMillis() + 12000
            while (js(expression) != "true") {
                check(SystemClock.uptimeMillis() < end) { label }
                Thread.sleep(150)
            }
        }
        await("App did not start", "document.body.classList.contains('android-app') && !!document.querySelector('.home-heading')")
        val menu = js("document.querySelector('.topbar-actions')?.innerHTML")
        check(menu.contains("language-button")) { "Language button missing from loaded header: " + menu.take(450) }
        js("document.querySelector('.language-button').click()")
        await("Language dialog did not open", "!!document.querySelector('#dialog[open] [data-lang=ru]')")
        js("document.querySelector('[data-lang=ru]').click()")
        await("Language setting did not update the home page", "document.documentElement.lang === 'ru' && document.querySelector('.home-heading h1')?.textContent === 'Для вас'")
        val oldPage = js("performance.timeOrigin")
        runOnMainSync { web.reload() }
        await("Russian language did not survive a reload", "performance.timeOrigin !== $oldPage && document.documentElement.lang === 'ru' && !!document.querySelector('.home-heading')")
        js("document.querySelector('.mobile-nav [data-view=library]').click()")
        await("Library did not open", "!!document.querySelector('.playlist-open')")
        js("document.querySelector('.playlist-open').click()")
        await("Saved playlist did not open", "!!document.querySelector('.track-row .song-title')")
        val rect = JSONArray(js("""(() => {
            const row = document.querySelector('.track-row');
            row.scrollIntoView({block:'center', behavior:'instant'});
            const r = row.getBoundingClientRect();
            const x = r.left + 20, y = r.top + r.height / 2;
            window.swipeEvents = [];
            for (const type of ['pointerdown','pointermove','pointerup','pointercancel']) {
                document.addEventListener(type, e => window.swipeEvents.push([type,e.pointerType,e.clientX,e.clientY,e.target.closest('.track-row') !== null]), true);
            }
            return [x*devicePixelRatio,y*devicePixelRatio,85*devicePixelRatio,!!document.elementFromPoint(x,y)?.closest('.track-row')];
        })()"""))
        check(rect.getBoolean(3)) { "Test song row is hidden behind the player" }
        runOnMainSync { web.getLocationOnScreen(origin) }
        val startX = origin[0] + rect.getDouble(0).toFloat()
        val startY = origin[1] + rect.getDouble(1).toFloat()
        val distance = rect.getDouble(2).toFloat()
        fun swipe(horizontal: Float, vertical: Float) {
            val down = SystemClock.uptimeMillis()
            fun send(action: Int, fraction: Float) {
                val finger = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
                val coordinates = MotionEvent.PointerCoords().apply { x = startX + horizontal * fraction; y = startY + vertical * fraction; pressure = 1f; size = 1f }
                val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, 1, arrayOf(finger), arrayOf(coordinates), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
                try { sendPointerSync(event) } finally { event.recycle() }
            }
            send(MotionEvent.ACTION_DOWN, 0f)
            for (step in 1..8) { Thread.sleep(18); send(MotionEvent.ACTION_MOVE, step / 8f) }
            send(MotionEvent.ACTION_UP, 1f)
        }
        swipe(distance / 3, 0f)
        check(js("document.querySelectorAll('.queue-item').length") == "0") { "A short swipe queued a track" }
        swipe(distance, 0f)
        val expected = JSONObject.quote(title)
        await("Full right swipe failed. Events: ${js("window.swipeEvents.slice(-12)")}", "document.querySelectorAll('.queue-item').length === 1 && document.querySelector('.queue-item strong').textContent === $expected")
        check(js("document.querySelector('#play-pause').getAttribute('aria-label')") == JSONObject.quote("Воспроизвести")) { "Swiping started playback" }
    }
}
