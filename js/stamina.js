// The breath bar: how much sprint is left (js/player.js _pace). It shows while
// he is sprinting, tired or getting his wind back, and is gone when full.
let root = null,
  fill = null;
export function staminaHud(player, visible = true) {
  if (!root) {
    root = document.createElement('div');
    root.className = 'stamina-bar';
    root.innerHTML = '<small>Dech</small><i><b></b></i>';
    fill = root.querySelector('b');
    document.body.append(root);
  }
  const show = visible && (player.sprinting || player.tired > 0 || player.stamina < 0.995);
  root.classList.toggle('on', show);
  if (!show) return;
  fill.style.width = (player.stamina * 100).toFixed(1) + '%';
  root.classList.toggle('tired', player.tired > 0);
}
