  // ⌘+ and ⌘− make the text on every sheet bigger or smaller, and ⌘0 puts it back to 13. It's the text
  // size each sheet already keeps, now set for all of them at once. Zooming the whole page from inside
  // it would draw the sheets' column handles in the wrong place, so the toolbars keep their size.
  const sheetTextSizes = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
  function paintSheetTextSize() {
    root.style.setProperty('--hc-sheet-text-size', (cameraLayout(cameraSetupSheet).textSize ?? 13) + 'px');
  }
  function nextSheetTextSize(current, direction) {
    if (!direction) return 13;
    const index = sheetTextSizes.indexOf(current), from = index >= 0 ? index : Math.max(0, sheetTextSizes.findIndex(size => size >= current));
    return sheetTextSizes[Math.max(0, Math.min(sheetTextSizes.length - 1, from + direction))];
  }
  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const direction = ['=', '+'].includes(event.key) ? 1 : ['-', '_'].includes(event.key) ? -1 : event.key === '0' ? 0 : null;
    if (direction === null) return;
    event.preventDefault();
    const next = nextSheetTextSize(cameraLayout(cameraSetupSheet).textSize ?? 13, direction);
    // Not an edit to undo, so it stays out of the sheets' undo history.
    for (const { id } of sheetOwners()) if ((cameraLayout(id).textSize ?? 13) !== next) changeCameraPresentation(id, () => { cameraLayout(id).textSize = next; }, false, false);
    paintSheetTextSize();
    toast('Text size ' + next + (next === 13 ? '' : ' · ⌘0 resets'));
  }, true);
  const restoreBeforeTextSize = restore;
  restore = function(...args) { const restored = restoreBeforeTextSize(...args); paintSheetTextSize(); return restored; };
