  // Every list choice on the page opens Hubble's own pop-up list instead of the system menu. The real
  // select stays underneath, out of sight, and still holds the value: picking an option sets it and
  // sends the same input and change events, so the code that reads it and the saved plan don't change.
  const dropdownChevron = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const dropdownCheck = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const selectIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let openDropdown = null, dropdownSequence = 0;

  function dropdownLabel(select) {
    const option = select.options[select.selectedIndex];
    return option ? option.textContent : '';
  }
  function paintDropdown(select) {
    const button = select.nextElementSibling;
    if (!button?.matches('.hc-dropdown')) return;
    const text = dropdownLabel(select);
    const label = button.querySelector('.hc-dropdown-value');
    if (label.textContent !== text) label.textContent = text;
    button.disabled = select.disabled;
    button.hidden = select.hidden;
    button.classList.toggle('hc-dropdown-placeholder', !select.value);
  }
  function upgradeSelect(select) {
    if (select.dataset.hcDropdown || select.multiple) return;
    select.dataset.hcDropdown = String(++dropdownSequence);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hc-dropdown' + (select.classList.contains('hc-cell-input') ? ' hc-dropdown-cell' : '');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    // The button takes the select's name, so there is one control called that, the one people use.
    button.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.querySelector('span')?.textContent || 'Choose');
    select.dataset.label = button.getAttribute('aria-label');
    select.removeAttribute('aria-label');
    button.innerHTML = '<span class="hc-dropdown-value"></span>' + dropdownChevron;
    select.classList.add('hc-native-select');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(button);
    // Code that sets the value directly, and options rebuilt in place, show on the button at once.
    Object.defineProperty(select, 'value', { configurable: true, get() { return selectValue.get.call(this); }, set(value) { selectValue.set.call(this, value); paintDropdown(this); } });
    Object.defineProperty(select, 'selectedIndex', { configurable: true, get() { return selectIndex.get.call(this); }, set(value) { selectIndex.set.call(this, value); paintDropdown(this); } });
    new MutationObserver(() => paintDropdown(select)).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected'] });
    select.addEventListener('change', () => paintDropdown(select));
    select.addEventListener('input', () => paintDropdown(select));
    // Focus that lands on the hidden select, from a label or the sheet's arrow keys, goes to the button.
    select.addEventListener('focus', () => { if (!button.disabled) button.focus(); });
    paintDropdown(select);
  }
  function upgradeSelects(scope) {
    if (scope.matches?.('select')) upgradeSelect(scope);
    for (const select of scope.querySelectorAll?.('select') ?? []) upgradeSelect(select);
  }

  function closeDropdown(focus = false) {
    if (!openDropdown) return;
    const { menu, button, abort } = openDropdown;
    openDropdown = null;
    abort.abort();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    if (focus && button.isConnected) button.focus();
  }
  function chooseDropdown(select, value) {
    closeDropdown(true);
    if (select.value === value) return;
    selectValue.set.call(select, value);
    paintDropdown(select);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function openDropdownFor(button) {
    const select = button.previousElementSibling;
    if (!select?.matches('select') || button.disabled) return;
    if (openDropdown?.button === button) { closeDropdown(true); return; }
    closeDropdown();
    const id = 'hc-dropdown-' + select.dataset.hcDropdown, menu = document.createElement('div');
    menu.className = 'hc-dropdown-menu';
    menu.id = id;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', button.getAttribute('aria-label'));
    const entries = [];
    let markup = '';
    for (const child of select.children) {
      const options = child.matches('optgroup') ? [...child.children] : [child];
      if (child.matches('optgroup')) markup += '<div class="hc-dropdown-group" role="presentation">' + esc(child.label) + '</div>';
      for (const option of options) {
        if (!option.matches('option')) continue;
        const index = entries.push(option) - 1, chosen = option.selected && option.value !== '';
        markup += '<div class="hc-dropdown-option' + (option.value === '' ? ' hc-dropdown-placeholder' : '') + '" role="option" id="' + id + '-' + index + '" data-index="' + index + '" aria-selected="' + chosen + '"' + (option.disabled || child.disabled ? ' aria-disabled="true"' : '') + '><span>' + esc(option.textContent) + '</span>' + (chosen ? dropdownCheck : '') + '</div>';
      }
    }
    menu.innerHTML = markup;
    root.append(menu);
    // Below the button when it fits, otherwise above it, and never past the window's edge.
    const box = button.getBoundingClientRect(), height = Math.min(menu.scrollHeight, 320);
    const below = window.innerHeight - box.bottom - 8, top = below >= height || below >= box.top ? box.bottom + 4 : box.top - 4 - height;
    Object.assign(menu.style, { top: Math.max(8, top) + 'px', left: Math.max(8, Math.min(box.left, window.innerWidth - Math.max(box.width, 200) - 8)) + 'px', minWidth: Math.max(box.width, 200) + 'px', maxHeight: height + 'px' });
    const abort = new AbortController();
    openDropdown = { menu, button, select, entries, abort, active: -1 };
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', id);
    const usable = index => entries[index] && !entries[index].disabled && !entries[index].parentElement.disabled;
    const highlight = index => {
      if (!usable(index)) return;
      openDropdown.active = index;
      for (const item of menu.querySelectorAll('.hc-dropdown-option')) item.classList.toggle('hc-dropdown-active', Number(item.dataset.index) === index);
      const item = menu.querySelector('[data-index="' + index + '"]');
      item?.scrollIntoView({ block: 'nearest' });
      button.setAttribute('aria-activedescendant', item?.id ?? '');
    };
    const move = (from, step) => { for (let index = from + step; index >= 0 && index < entries.length; index += step) if (usable(index)) return index; return from; };
    highlight(Math.max(0, entries.findIndex(option => option.selected)));
    menu.addEventListener('pointermove', event => { const item = event.target.closest('.hc-dropdown-option'); if (item) highlight(Number(item.dataset.index)); }, { signal: abort.signal });
    menu.addEventListener('pointerdown', event => event.preventDefault(), { signal: abort.signal });
    menu.addEventListener('click', event => {
      const item = event.target.closest('.hc-dropdown-option');
      if (item && usable(Number(item.dataset.index))) chooseDropdown(select, entries[Number(item.dataset.index)].value);
    }, { signal: abort.signal });
    let typed = '', typedAt = 0;
    button.addEventListener('keydown', event => {
      // Keys the open list uses go no further, so the sheet or the page don't act on them too.
      if (['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeDropdown(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(move(openDropdown.active, event.key === 'ArrowDown' ? 1 : -1)); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); highlight(event.key === 'Home' ? move(-1, 1) : move(entries.length, -1)); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (usable(openDropdown.active)) chooseDropdown(select, entries[openDropdown.active].value); }
      else if (event.key === 'Tab') closeDropdown();
      else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        // Typing jumps to the first option that starts with what was typed.
        typed = (Date.now() - typedAt > 700 ? '' : typed) + event.key.toLowerCase();
        typedAt = Date.now();
        const found = entries.findIndex((option, index) => usable(index) && option.textContent.trim().toLowerCase().startsWith(typed));
        if (found >= 0) highlight(found);
      }
    }, { signal: abort.signal });
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !button.contains(event.target)) closeDropdown(); }, { signal: abort.signal, capture: true });
    window.addEventListener('resize', () => closeDropdown(), { signal: abort.signal });
    document.addEventListener('scroll', event => { if (!menu.contains(event.target)) closeDropdown(); }, { signal: abort.signal, capture: true });
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('.hc-dropdown');
    if (button) openDropdownFor(button);
  });
  root.addEventListener('keydown', event => {
    const button = event.target.closest?.('.hc-dropdown');
    if (!button || openDropdown?.button === button) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openDropdownFor(button); }
  });
  upgradeSelects(root);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) upgradeSelects(node);
    // A list whose button was redrawn away closes with it.
    if (openDropdown && !openDropdown.button.isConnected) closeDropdown();
  }).observe(root, { childList: true, subtree: true });
