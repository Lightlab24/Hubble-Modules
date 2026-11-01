export function renderLabel(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    value.text.length > 200
  )
    throw new Error("Invalid label text");
  const text = value.text;
  return { text: `Preview: ${text}` };
}
