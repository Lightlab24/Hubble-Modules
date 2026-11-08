/** An On/Off switch that reports the next value; the caller shows it at once. */
export function SettingSwitch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="setting-switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span className="setting-switch-track" aria-hidden="true">
        <span />
      </span>
      <span aria-hidden="true">{checked ? "On" : "Off"}</span>
    </button>
  );
}
