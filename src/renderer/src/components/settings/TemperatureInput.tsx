import { useState } from 'react'

export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2
export const TEMPERATURE_STEP = 0.01

const roundTemperature = (value: number) => Math.round(value * 100) / 100
const clampTemperature = (value: number) =>
  Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, roundTemperature(value)))

interface Props {
  value: number
  disabled?: boolean
  onCommit: (value: number) => void
}

/** Number input that allows temporary out-of-range text and clamps on blur. */
export function TemperatureInput({ value, disabled, onCommit }: Props) {
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const display = focused ? text : String(roundTemperature(value))

  return (
    <input
      type="number"
      className="input-field temp-number"
      min={TEMPERATURE_MIN}
      max={TEMPERATURE_MAX}
      step={TEMPERATURE_STEP}
      value={display}
      disabled={disabled}
      onFocus={() => {
        setFocused(true)
        setText(String(roundTemperature(value)))
      }}
      onChange={(event) => {
        setText(event.target.value)
        const next = parseFloat(event.target.value)
        if (Number.isFinite(next)) onCommit(roundTemperature(next))
      }}
      onBlur={() => {
        setFocused(false)
        const next = parseFloat(text)
        onCommit(Number.isFinite(next) ? clampTemperature(next) : roundTemperature(value))
      }}
    />
  )
}
