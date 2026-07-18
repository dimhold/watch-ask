package com.dimhold.watchask

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.view.ViewGroup
import android.widget.Button
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.util.Locale

/**
 * Voice, pitch and speed, chosen by ear rather than by reading identifiers.
 *
 * The list is built from whatever the watch actually has installed for the
 * configured language, so it stays correct as Google ships and drops voices,
 * and it works the same whichever language you set.
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var voiceGroup: RadioGroup
    private lateinit var pitchBar: SeekBar
    private lateinit var rateBar: SeekBar
    private lateinit var pitchLabel: TextView
    private lateinit var rateLabel: TextView

    private var tts: TextToSpeech? = null
    private var voices: List<Voice> = emptyList()

    private val prefs by lazy { getSharedPreferences("watchask", MODE_PRIVATE) }

    private val language: String
        get() = prefs.getString("language", null)?.takeIf { it.isNotEmpty() }
            ?: BuildConfig.SPEECH_LANGUAGE.takeIf { it.isNotEmpty() }
            ?: Locale.getDefault().toLanguageTag()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        voiceGroup = findViewById(R.id.voiceGroup)
        pitchBar = findViewById(R.id.pitchBar)
        rateBar = findViewById(R.id.rateBar)
        pitchLabel = findViewById(R.id.pitchLabel)
        rateLabel = findViewById(R.id.rateLabel)

        // Sliders run 50..200% of normal; SeekBar starts at 0, so store offset by 50.
        pitchBar.progress = (prefs.getFloat("pitch", 1f) * 100).toInt() - 50
        rateBar.progress = (prefs.getFloat("rate", 1f) * 100).toInt() - 50
        updateLabels()

        val sliderListener = object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) =
                updateLabels()

            override fun onStartTrackingTouch(bar: SeekBar?) {}
            override fun onStopTrackingTouch(bar: SeekBar?) = speakSample()
        }
        pitchBar.setOnSeekBarChangeListener(sliderListener)
        rateBar.setOnSeekBarChangeListener(sliderListener)

        findViewById<Button>(R.id.testButton).setOnClickListener { speakSample() }
        findViewById<Button>(R.id.saveButton).setOnClickListener {
            save()
            finish()
        }

        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.forLanguageTag(language)
                runOnUiThread { buildVoiceList() }
            }
        }
    }

    private fun pitch() = (pitchBar.progress + 50) / 100f
    private fun rate() = (rateBar.progress + 50) / 100f

    private fun updateLabels() {
        pitchLabel.text = getString(R.string.pitch_fmt, (pitch() * 100).toInt())
        rateLabel.text = getString(R.string.rate_fmt, (rate() * 100).toInt())
    }

    private fun buildVoiceList() {
        val wanted = Locale.forLanguageTag(language).language
        // Offline voices first: they work on a walk with no signal.
        voices = tts?.voices
            ?.filter { it.locale.language == wanted }
            ?.sortedWith(compareBy({ it.isNetworkConnectionRequired }, { it.name }))
            .orEmpty()

        val current = prefs.getString("voice", null)
        voiceGroup.removeAllViews()

        voices.forEachIndexed { i, voice ->
            val button = RadioButton(this).apply {
                id = 1000 + i
                text = describe(voice, i)
                textSize = 12f
                setTextColor(0xFFF2F2F2.toInt())
                buttonTintList = android.content.res.ColorStateList.valueOf(
                    resources.getColor(R.color.accent, theme)
                )
                layoutParams = RadioGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                isChecked = voice.name == current
            }
            voiceGroup.addView(button)
        }
        // Nothing saved yet: the first entry is what TTS would pick anyway.
        if (voiceGroup.checkedRadioButtonId == -1 && voices.isNotEmpty()) {
            (voiceGroup.getChildAt(0) as RadioButton).isChecked = true
        }
        voiceGroup.setOnCheckedChangeListener { _, _ -> speakSample() }
    }

    /**
     * Voice ids look like "en-us-x-iom-local" and mean nothing to a human, and
     * the naming differs per language, so they are numbered in the order the
     * engine reports them and you pick by listening. Network voices are marked
     * because they go silent the moment you walk out of signal.
     */
    private fun describe(voice: Voice, index: Int): String {
        val label = getString(R.string.voice_n, index + 1)
        return if (voice.isNetworkConnectionRequired) {
            "$label · ${getString(R.string.needs_network)}"
        } else {
            label
        }
    }

    private fun selectedVoice(): Voice? {
        val index = voiceGroup.checkedRadioButtonId - 1000
        return voices.getOrNull(index)
    }

    private fun speakSample() {
        val tts = tts ?: return
        selectedVoice()?.let { tts.voice = it }
        tts.setPitch(pitch())
        tts.setSpeechRate(rate())
        tts.speak(getString(R.string.voice_sample), TextToSpeech.QUEUE_FLUSH, null, "sample")
    }

    private fun save() {
        prefs.edit()
            .putString("voice", selectedVoice()?.name)
            .putFloat("pitch", pitch())
            .putFloat("rate", rate())
            .apply()
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }
}
