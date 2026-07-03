function initBackgroundPicker() {
  const colorInput = document.getElementById('bgColor');
  const hexInput = document.getElementById('bgHex');
  const presets = document.querySelectorAll('.bg-preset');

  function setColor(hex) {
    colorInput.value = hex;
    hexInput.value = hex;
  }

  colorInput.addEventListener('input', () => setColor(colorInput.value));
  hexInput.addEventListener('change', () => {
    let value = hexInput.value.trim();
    if (!value.startsWith('#')) value = `#${value}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) setColor(value.toLowerCase());
    else hexInput.value = colorInput.value;
  });
  presets.forEach((btn) => {
    btn.addEventListener('click', () => setColor(btn.dataset.color));
  });

  return () => colorInput.value;
}
