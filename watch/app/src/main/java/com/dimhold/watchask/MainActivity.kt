package com.dimhold.watchask

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

private const val TAG = "watch-ask"

/** Long enough for the engine to let go of the mic before we grab it again. */
private const val RESTART_DELAY_MS = 150L

/** Consecutive engine failures tolerated before giving up. Long pauses can
 *  knock the recogniser over repeatedly, so this is generous. The counter
 *  resets the moment the engine produces anything at all. */
private const val MAX_RESTART_FAILURES = 10

/** How often the answer is collected, and how long we keep collecting for. */
private const val POLL_INTERVAL_MS = 2000L
private const val ANSWER_TIMEOUT_MS = 300_000L

/**
 * Ask a question out loud, get an answer back.
 *
 * Recognition runs in-process through SpeechRecognizer rather than the system
 * RecognizerIntent: no Google overlay on top of the watch face, partial words
 * land on our own screen as they are spoken, and we decide when listening
 * stops. Recognition itself happens on the watch and costs nothing.
 *
 * Nothing here remembers anything. One question, one answer, and the next
 * question starts from scratch.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var pulse: PulseView
    private lateinit var replyScroll: ScrollView
    private lateinit var heardText: TextView
    private lateinit var replyText: TextView
    private lateinit var hintText: TextView
    private lateinit var liveText: TextView
    private lateinit var askAgainButton: ImageButton
    private lateinit var speakButton: ImageButton

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var speaking = false

    private var recognizer: SpeechRecognizer? = null

    /**
     * True from startListening until the engine delivers a result or an error.
     *
     * Deliberately NOT cleared in onEndOfSpeech: the engine stops *hearing*
     * seconds before it hands over the text, and treating that as "done" made
     * the stop button fire on an empty transcript while the words were still in
     * flight.
     */
    private var engineBusy = false

    /**
     * Last partial text of the current segment. onResults sometimes comes back
     * null even though partials were arriving, and this is the fallback, so a
     * spoken sentence is never silently dropped.
     */
    private var lastPartial = ""

    /** Ours: the session stays open until the button is pressed again. */
    private var holdOpen = false

    /** True once the engine has confirmed it is actually listening. */
    private var micLive = false

    /** Everything heard across the segments of the current session. */
    private val transcript = StringBuilder()

    private var restartFailures = 0
    private val handler = Handler(Looper.getMainLooper())

    /** Kept so the reply can be replayed. You miss it mid-run, you press again. */
    private var lastReply: String = ""

    private var workingSince = 0L

    /**
     * Runtime config, so a new backend URL or a different voice does not mean a
     * rebuild. BuildConfig only supplies the initial values.
     *
     *   adb shell am start -n com.dimhold.watchask/.MainActivity \
     *       -e url http://192.0.2.10:8787 -e token abc123 -e lang en-US
     */
    private val prefs by lazy { getSharedPreferences("watchask", MODE_PRIVATE) }

    private var backendUrl: String
        get() = prefs.getString("backend_url", null) ?: BuildConfig.BACKEND_URL
        set(v) = prefs.edit().putString("backend_url", v).apply()

    private var backendToken: String
        get() = prefs.getString("backend_token", null) ?: BuildConfig.BACKEND_TOKEN
        set(v) = prefs.edit().putString("backend_token", v).apply()

    /**
     * BCP-47 tag for both recognition and speech. Empty means the watch's own
     * locale, which is the right answer for most people and the reason this is
     * not pinned to one language.
     */
    private var language: String
        get() = prefs.getString("language", null)?.takeIf { it.isNotEmpty() }
            ?: BuildConfig.SPEECH_LANGUAGE.takeIf { it.isNotEmpty() }
            ?: Locale.getDefault().toLanguageTag()
        set(v) = prefs.edit().putString("language", v).apply()

    private var voiceName: String?
        get() = prefs.getString("voice", null)
        set(v) = prefs.edit().putString("voice", v).apply()

    private val pitch get() = prefs.getFloat("pitch", 1f)
    private val rate get() = prefs.getFloat("rate", 1f)

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startSession() else showReply(getString(R.string.no_mic))
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Never sleep while the app is open. A watch dimming mid-sentence is
        // worse than the battery it saves: you lose the answer and the thread.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        pulse = findViewById(R.id.pulse)
        replyScroll = findViewById(R.id.replyScroll)
        heardText = findViewById(R.id.heardText)
        replyText = findViewById(R.id.replyText)
        hintText = findViewById(R.id.hintText)
        liveText = findViewById(R.id.liveText)
        askAgainButton = findViewById(R.id.askAgainButton)
        speakButton = findViewById(R.id.speakButton)

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.forLanguageTag(language)
                tts?.setOnUtteranceProgressListener(ttsProgress)
                applyVoiceSettings()
                ttsReady = true
            }
        }

        findViewById<ImageButton>(R.id.settingsButton).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        pulse.setOnClickListener { toggleListening() }
        askAgainButton.setOnClickListener { toggleListening() }
        speakButton.setOnClickListener {
            // One button, two meanings: stop it talking, or say it again.
            if (speaking) stopSpeaking() else speak(lastReply)
        }

        applyConfigFrom(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyConfigFrom(intent)
    }

    // --- listening ----------------------------------------------------------

    private fun toggleListening() {
        if (holdOpen) stopSession() else requestMicThenListen()
    }

    private fun requestMicThenListen() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) startSession() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    /**
     * A session lasts until the button is pressed again, however long the
     * pauses. The engine will not do that on its own: it hangs up after a
     * second or two of silence no matter what the silence-length extras ask
     * for. So a session is a chain of engine segments, restarted under the
     * hood, their text glued together in [transcript].
     */
    private fun startSession() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            showReply(getString(R.string.no_recognizer))
            return
        }
        // Talking over ourselves makes the mic hear the watch's own voice and
        // send back a garbled echo of the last answer.
        stopSpeaking()

        transcript.setLength(0)
        restartFailures = 0
        holdOpen = true
        micLive = false
        showListeningScreen()
        startSegment()
    }

    /** Short buzz. On a walk you feel it, you do not have to look. */
    private fun buzz() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as Vibrator
        }
        vibrator.vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE))
    }

    private fun startSegment() {
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(recognitionListener)
        }

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            // A hint, not a promise: Google's recognizer often ignores it. When
            // it does listen, segments get longer and fewer words fall into the
            // seam of a restart.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 10_000)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 10_000)
        }

        engineBusy = true
        lastPartial = ""
        recognizer?.startListening(intent)
    }

    /** Picks up the next segment unless the button was pressed in the meantime. */
    private fun restartSegment() {
        handler.postDelayed({ if (holdOpen) startSegment() }, RESTART_DELAY_MS)
    }

    private fun keep(said: String?) {
        if (said.isNullOrEmpty()) return
        // A restart can replay the tail of the previous segment; do not say it twice.
        if (transcript.endsWith(said)) return
        if (transcript.isNotEmpty()) transcript.append(' ')
        transcript.append(said)
    }

    /** Stops recording but still delivers whatever was heard so far. */
    private fun stopSession() {
        if (!holdOpen) return
        holdOpen = false
        // The engine takes a moment to hand over the text. Without this, the
        // button silently turns back into a mic and a second impatient tap
        // starts recording again instead of sending.
        setControlsEnabled(false)
        Log.i(TAG, "stopSession: engineBusy=$engineBusy")
        // If the engine is still working, wait for its text: onResults or
        // onError will finish the session. Mid-restart there is nothing to
        // wait for.
        if (engineBusy) recognizer?.stopListening() else finishSession()
    }

    private fun finishSession() {
        holdOpen = false
        engineBusy = false
        keep(lastPartial)
        val said = transcript.toString().trim()
        if (said.isEmpty()) showIdleScreen() else {
            heardText.text = said
            ask(said)
        }
    }

    private val recognitionListener = object : RecognitionListener {
        /**
         * The engine is only listening from here. Before this it can even drop
         * dead (error 11, seen on nearly every session). Showing "listening"
         * from the button press meant the first words went nowhere: you spoke,
         * nothing recorded them. Buzz and pulse now, not earlier.
         */
        override fun onReadyForSpeech(params: Bundle?) {
            if (holdOpen && !micLive) {
                micLive = true
                pulse.state = PulseView.State.LISTENING
                hintText.visibility = View.GONE
                buzz()
            }
        }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        /** Heard the end of a phrase, but the text is not here yet, so the
         *  engine is still busy. Clearing state here is what broke the stop
         *  button: it fired on an empty transcript. */
        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            engineBusy = false
            Log.i(TAG, "onError($error) holdOpen=$holdOpen")
            when (error) {
                // Silence is not a problem while the session is held open.
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                    if (holdOpen) restartSegment() else finishSession()

                // The only error worth stopping for: nothing works without a mic.
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    holdOpen = false
                    showReply(getString(R.string.no_mic))
                }

                // Everything else is the engine having a bad moment. It drops
                // the connection during long pauses (code 11), gets busy, gets
                // confused. While the session is held open the user is still
                // mid-thought, so pick the engine back up rather than throwing
                // an error code at someone who is out for a walk. The failure
                // counter stops this becoming an infinite loop.
                else ->
                    if (holdOpen && ++restartFailures <= MAX_RESTART_FAILURES) restartSegment()
                    else finishSession()
            }
        }

        /** Words appear on our screen as they are spoken, and are remembered in
         *  case the final result comes back empty. */
        override fun onPartialResults(partialResults: Bundle?) {
            partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.let {
                    // Words coming through means the engine is healthy, whatever
                    // it did a moment ago.
                    restartFailures = 0
                    lastPartial = it
                    liveText.text = (transcript.toString() + ' ' + it).trim()
                }
        }

        override fun onResults(results: Bundle?) {
            engineBusy = false
            restartFailures = 0
            val final = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
                ?.trim()
            // The engine can return nothing even after streaming partials, and
            // then the partials are the only record of what was said.
            val segment = if (final.isNullOrEmpty()) lastPartial else final
            keep(segment)
            lastPartial = ""
            if (holdOpen) {
                liveText.text = transcript
                restartSegment()
            } else {
                finishSession()
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    // --- asking -------------------------------------------------------------

    private fun ask(text: String) {
        pulse.state = PulseView.State.THINKING
        pulse.visibility = View.VISIBLE
        replyScroll.visibility = View.GONE
        setControlsEnabled(false)
        startWorkingTimer()

        lifecycleScope.launch {
            val reply = try {
                askBackend(text)
            } catch (e: Exception) {
                Log.e(TAG, "backend call failed", e)
                getString(R.string.no_backend, e.message ?: "")
            }
            stopWorkingTimer()
            showReply(reply)
            speak(reply)
        }
    }

    /**
     * A spinning arc alone does not say whether anything is happening. It looks
     * identical whether the backend is working or the request died. A running
     * counter is proof of life, and it tells you whether this is 5 seconds or 50.
     */
    private fun startWorkingTimer() {
        workingSince = SystemClock.elapsedRealtime()
        liveText.visibility = View.VISIBLE
        handler.post(workingTick)
    }

    private fun stopWorkingTimer() {
        handler.removeCallbacks(workingTick)
        workingSince = 0L
    }

    private val workingTick = object : Runnable {
        override fun run() {
            val seconds = ((SystemClock.elapsedRealtime() - workingSince) / 1000).toInt()
            liveText.text = getString(R.string.working_fmt, seconds)
            handler.postDelayed(this, 1000)
        }
    }

    /**
     * Hand the question over, then collect the answer.
     *
     * Never one long request. A local agent regularly thinks for minutes, and
     * anything sitting in front of it (a tunnel, a dozing radio) will kill a
     * socket held open that long and throw a finished answer away. Both calls
     * here return in a blink, so the backend can take as long as it likes. The
     * server also speaks a plain synchronous POST /ask, which is the simpler
     * contract and what scripts use.
     */
    private suspend fun askBackend(text: String): String = withContext(Dispatchers.IO) {
        val jobId = startJob(text)
        var waited = 0L
        while (waited < ANSWER_TIMEOUT_MS) {
            Thread.sleep(POLL_INTERVAL_MS)
            waited += POLL_INTERVAL_MS
            val (status, value) = pollJob(jobId)
            when (status) {
                "done" -> return@withContext value
                "failed" -> return@withContext getString(R.string.no_backend, value)
            }
        }
        getString(R.string.answer_timeout)
    }

    private fun startJob(text: String): String {
        val body = JSONObject().put("question", text).toString().toByteArray(Charsets.UTF_8)
        // Read through the overridable properties, not BuildConfig directly.
        // Otherwise a pushed URL is stored but never actually used.
        val conn = (URL("$backendUrl/ask?mode=async").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Authorization", "Bearer $backendToken")
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 30_000
        }
        try {
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = JSONObject(raw)
            if (code !in 200..299) {
                throw Exception("backend replied $code: ${json.optString("error", raw)}")
            }
            return json.getString("jobId")
        } finally {
            conn.disconnect()
        }
    }

    /** Returns status to (reply | error). A dropped poll is not fatal: retry. */
    private fun pollJob(jobId: String): Pair<String, String> {
        val conn = (URL("$backendUrl/result/$jobId").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("Authorization", "Bearer $backendToken")
            connectTimeout = 15_000
            readTimeout = 30_000
        }
        return try {
            val code = conn.responseCode
            if (code !in 200..299) return "working" to ""
            val raw = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val json = JSONObject(raw)
            when (json.optString("status")) {
                "done" -> "done" to json.optString("reply", "")
                "failed" -> "failed" to json.optString("error", "")
                else -> "working" to ""
            }
        } catch (e: Exception) {
            // Flaky link: keep waiting rather than throwing the answer away.
            Log.w(TAG, "poll failed: ${e.message}")
            "working" to ""
        } finally {
            conn.disconnect()
        }
    }

    // --- speaking -----------------------------------------------------------

    private val ttsProgress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = runOnUiThread {
            speaking = true
            updateSpeakButton()
        }

        override fun onDone(utteranceId: String?) = runOnUiThread {
            speaking = false
            updateSpeakButton()
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = runOnUiThread {
            speaking = false
            updateSpeakButton()
        }
    }

    private fun speak(text: String) {
        if (ttsReady && text.isNotEmpty()) {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "reply")
        }
    }

    private fun stopSpeaking() {
        tts?.stop()
        speaking = false
        updateSpeakButton()
    }

    private fun updateSpeakButton() {
        speakButton.setImageResource(if (speaking) R.drawable.ic_stop else R.drawable.ic_replay)
        speakButton.contentDescription =
            getString(if (speaking) R.string.stop_speaking else R.string.replay)
    }

    // --- screens ------------------------------------------------------------

    /** Greyed-out controls are honest: a tap that does nothing reads as broken. */
    private fun setControlsEnabled(enabled: Boolean) {
        pulse.isEnabled = enabled
        pulse.alpha = if (enabled) 1f else 0.45f
        askAgainButton.isEnabled = enabled
        askAgainButton.alpha = if (enabled) 1f else 0.45f
    }

    private fun showIdleScreen() {
        stopWorkingTimer()
        pulse.state = PulseView.State.IDLE
        pulse.visibility = View.VISIBLE
        replyScroll.visibility = View.GONE
        liveText.visibility = View.GONE
        hintText.visibility = View.VISIBLE
        setControlsEnabled(true)
    }

    private fun showListeningScreen() {
        liveText.text = ""
        liveText.visibility = View.VISIBLE
        replyScroll.visibility = View.GONE
        pulse.visibility = View.VISIBLE
        // "Wait" until the engine confirms it is live. See onReadyForSpeech.
        hintText.text = getString(R.string.getting_ready)
        hintText.visibility = View.VISIBLE
        pulse.state = PulseView.State.THINKING
        setControlsEnabled(true)
    }

    private fun showReply(text: String) {
        stopWorkingTimer()
        lastReply = text
        replyText.text = text
        replyScroll.scrollTo(0, 0)
        replyScroll.visibility = View.VISIBLE
        pulse.visibility = View.GONE
        liveText.visibility = View.GONE
        hintText.visibility = View.GONE
        pulse.state = PulseView.State.IDLE
        setControlsEnabled(true)
        updateSpeakButton()
    }

    // --- config -------------------------------------------------------------

    private fun applyConfigFrom(intent: Intent?) {
        intent?.getStringExtra("url")?.trim()?.takeIf { it.isNotEmpty() }?.let {
            backendUrl = it.removeSuffix("/")
            Log.i(TAG, "backend url set")
        }
        // Never logged, only stored. It is the lock on someone's machine.
        intent?.getStringExtra("token")?.trim()?.takeIf { it.isNotEmpty() }?.let {
            backendToken = it
            Log.i(TAG, "backend token set")
        }
        intent?.getStringExtra("lang")?.trim()?.takeIf { it.isNotEmpty() }?.let {
            language = it
            tts?.language = Locale.forLanguageTag(it)
            Log.i(TAG, "language set to $it")
        }
        intent?.getStringExtra("voice")?.trim()?.takeIf { it.isNotEmpty() }?.let {
            voiceName = it
            applyVoiceSettings()
        }
    }

    /** Re-read on every resume so changes made in Settings take effect at once. */
    private fun applyVoiceSettings() {
        val name = voiceName
        if (name != null) {
            val match: Voice? = tts?.voices?.firstOrNull { it.name == name }
            if (match != null) tts?.voice = match
            else Log.w(TAG, "voice $name not found; keeping default")
        }
        tts?.setPitch(pitch)
        tts?.setSpeechRate(rate)
    }

    override fun onResume() {
        super.onResume()
        if (ttsReady) {
            tts?.language = Locale.forLanguageTag(language)
            applyVoiceSettings()
        }
    }

    override fun onDestroy() {
        holdOpen = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }
}
