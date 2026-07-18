package com.dimhold.watchask

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.min
import kotlin.math.sin

/**
 * The whole UI, really: a mic button that says what's happening by how it moves.
 *
 * Idle breathes slowly, listening pulses out in rings, thinking sweeps an arc.
 * State is legible at a glance with no text at all, which matters on a watch
 * you look at for half a second while walking.
 */
class PulseView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    enum class State { IDLE, LISTENING, THINKING }

    var state: State = State.IDLE
        set(value) {
            if (field != value) {
                field = value
                phase = 0f
                animator.duration = when (value) {
                    State.IDLE -> 3600L      // slow breath
                    State.LISTENING -> 1100L // quick, alive
                    State.THINKING -> 1500L  // steady sweep
                }
                animator.start()
                invalidate()
            }
        }

    // Read from colors.xml so retheming is one file.
    // One source for the accent, so retheming the app is a single colour file.
    private val amber = context.getColor(R.color.accent)
    private val amberDim = context.getColor(R.color.accent_dim)

    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val micPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val arcRect = RectF()

    private var phase = 0f

    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 3600L
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            phase = it.animatedValue as Float
            invalidate()
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        animator.start()
    }

    override fun onDetachedFromWindow() {
        animator.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val maxR = min(width, height) / 2f
        val coreR = maxR * 0.42f

        when (state) {
            State.IDLE -> drawBreath(canvas, cx, cy, coreR, maxR)
            State.LISTENING -> drawRipples(canvas, cx, cy, coreR, maxR)
            State.THINKING -> drawSweep(canvas, cx, cy, coreR, maxR)
        }

        // Core disc: a steady anchor under whatever the rings are doing.
        val breath = if (state == State.IDLE) 1f + 0.03f * sin(phase * 2 * Math.PI).toFloat() else 1f
        corePaint.color = if (state == State.THINKING) amberDim else amber
        canvas.drawCircle(cx, cy, coreR * breath, corePaint)

        // While listening the disc *is* the stop button. One target, no hunting
        // for a second control mid-sentence.
        if (state == State.LISTENING) drawStop(canvas, cx, cy, coreR)
        else drawMic(canvas, cx, cy, coreR * breath)
    }

    /** A single ring easing in and out. Resting, not dead. */
    private fun drawBreath(canvas: Canvas, cx: Float, cy: Float, coreR: Float, maxR: Float) {
        val t = (sin(phase * 2 * Math.PI).toFloat() + 1f) / 2f
        ringPaint.color = amber
        ringPaint.alpha = (30 + 40 * t).toInt()
        ringPaint.strokeWidth = 2f + 2f * t
        canvas.drawCircle(cx, cy, coreR + (maxR - coreR) * (0.35f + 0.15f * t), ringPaint)
    }

    /** Rings racing outward: unmistakably "I am hearing you right now". */
    private fun drawRipples(canvas: Canvas, cx: Float, cy: Float, coreR: Float, maxR: Float) {
        for (i in 0 until 3) {
            val t = (phase + i / 3f) % 1f
            val r = coreR + (maxR - coreR) * t
            ringPaint.color = amber
            ringPaint.alpha = ((1f - t) * 170).toInt()
            ringPaint.strokeWidth = 3.5f * (1f - t) + 1f
            canvas.drawCircle(cx, cy, r, ringPaint)
        }
    }

    /** A sweeping arc: work in progress, and not waiting on you. */
    private fun drawSweep(canvas: Canvas, cx: Float, cy: Float, coreR: Float, maxR: Float) {
        val r = coreR + (maxR - coreR) * 0.45f
        arcRect.set(cx - r, cy - r, cx + r, cy + r)

        ringPaint.color = amberDim
        ringPaint.alpha = 45
        ringPaint.strokeWidth = 3f
        canvas.drawCircle(cx, cy, r, ringPaint)

        ringPaint.color = amber
        ringPaint.alpha = 255
        ringPaint.strokeWidth = 3.5f
        canvas.drawArc(arcRect, phase * 360f - 90f, 90f, false, ringPaint)
    }

    /** Rounded square: universally "stop", legible at a glance while moving. */
    private fun drawStop(canvas: Canvas, cx: Float, cy: Float, coreR: Float) {
        micPaint.style = Paint.Style.FILL
        micPaint.color = Color.WHITE
        val half = coreR * 0.34f
        val r = coreR * 0.10f
        arcRect.set(cx - half, cy - half, cx + half, cy + half)
        canvas.drawRoundRect(arcRect, r, r, micPaint)
    }

    /** Mic glyph drawn straight onto the disc. No asset, no scaling surprises. */
    private fun drawMic(canvas: Canvas, cx: Float, cy: Float, coreR: Float) {
        micPaint.color = Color.WHITE
        val capsuleW = coreR * 0.30f
        val capsuleH = coreR * 0.62f
        val top = cy - capsuleH * 0.62f

        val body = RectF(cx - capsuleW / 2, top, cx + capsuleW / 2, top + capsuleH)
        canvas.drawRoundRect(body, capsuleW / 2, capsuleW / 2, micPaint)

        micPaint.style = Paint.Style.STROKE
        micPaint.strokeWidth = coreR * 0.09f
        val cradleR = coreR * 0.42f
        arcRect.set(cx - cradleR, cy - cradleR * 0.55f, cx + cradleR, cy + cradleR * 1.05f)
        canvas.drawArc(arcRect, 0f, 180f, false, micPaint)

        micPaint.strokeCap = Paint.Cap.ROUND
        canvas.drawLine(cx, cy + cradleR * 0.78f, cx, cy + coreR * 0.72f, micPaint)
        micPaint.style = Paint.Style.FILL
    }
}
