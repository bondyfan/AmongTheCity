export function storyHud() {
  const root = document.createElement('div');
  root.className = 'journey-hud';
  root.innerHTML =
    '<div class="journey-heading"><small></small><strong></strong><span></span></div><div class="journey-caption" aria-live="polite"><b></b><p></p></div><button type="button"></button>';
  const phone = document.createElement('aside');
  phone.className = 'journey-phone';
  phone.innerHTML = '<i></i><small></small><strong></strong><span></span>';
  phone.hidden = true;
  root.append(phone);
  document.body.append(root);
  const [location, title, hint, speaker, line, button] = root.querySelectorAll(
    'small,strong,span,b,p,button',
  );
  line.parentElement.hidden = true;
  button.hidden = true;
  function put(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  const timer = document.createElement('div'),
    skip = document.createElement('button'),
    travel = document.createElement('div');
  timer.className = 'journey-timer';
  skip.className = 'journey-skip';
  travel.className = 'journey-travel';
  timer.innerHTML = '<small>Do odjezdu</small><b></b>';
  skip.type = 'button';
  skip.textContent = 'T　Přeskočit cestu';
  travel.innerHTML =
    '<div><small>POSLEDNÍ VLAK</small><section><strong>Kolín</strong><strong>Pardubice</strong></section><div class="journey-track"><i aria-hidden="true"><b></b><b></b><b></b></i></div></div>';
  timer.hidden = skip.hidden = travel.hidden = true;
  // A black card for cuts between scenes, and the pin that marks the station.
  const veil = document.createElement('div'),
    pin = document.createElement('div');
  veil.className = 'journey-veil';
  veil.innerHTML = '<div><strong></strong><span></span></div>';
  pin.className = 'journey-pin';
  pin.innerHTML = '<i></i><b></b><small></small>';
  pin.hidden = true;
  root.append(timer, skip, travel, pin, veil);
  return {
    root,
    button,
    skip,
    countdown(value, urgent) {
      timer.hidden = !value;
      put(timer.lastChild, value || '');
      timer.classList.toggle('urgent', urgent);
    },
    seated(on) {
      this.offer(on ? 'Přeskočit cestu' : '');
    },
    // T: what may be skipped right now ('' takes the button away)
    offer(label = '') {
      skip.hidden = !label;
      if (label) put(skip, 'T　' + label);
    },
    travel(on) {
      if (on) {
        travel.hidden = false;
        travel.classList.remove('arrived');
        return;
      }
      travel.classList.add('arrived');
      travel.addEventListener(
        'animationend',
        (event) => {
          if (event.target === travel && travel.classList.contains('arrived')) travel.hidden = true;
        },
        { once: true },
      );
    },
    cinema(on) {
      document.body.classList.toggle('story-cinema', on);
    },
    // Fade to black (and back). A title and a line may stand on the black.
    // `instant` drops it without the fade (the first frame of the film).
    veil(on, title = '', line = '', instant = false) {
      if (instant) {
        veil.style.transition = 'none';
        veil.classList.toggle('on', on);
        void veil.offsetWidth;
        veil.style.transition = '';
      }
      veil.classList.toggle('on', on);
      if (on || title) {
        put(veil.querySelector('strong'), title);
        put(veil.querySelector('span'), line);
      }
    },
    // The station pin: x and y are 0..1 of the window, `off` is the bearing in
    // radians when the place is outside the picture (the pin then rides the rim).
    pin(x, y, label = '', metres = '', off = null) {
      pin.hidden = x === undefined;
      if (pin.hidden) return;
      pin.style.left = (x * 100).toFixed(2) + '%';
      pin.style.top = (y * 100).toFixed(2) + '%';
      pin.classList.toggle('off', off !== null);
      pin.firstChild.style.transform = off === null ? '' : 'rotate(' + off.toFixed(3) + 'rad)';
      put(pin.querySelector('b'), label);
      put(pin.querySelector('small'), metres);
    },
    guide(place, task, help = '') {
      put(location, place);
      put(title, task);
      put(hint, help);
    },
    say(who = '', what = '') {
      put(speaker, who);
      put(line, what);
      line.parentElement.hidden = !what;
    },
    action(label = '') {
      button.hidden = !label;
      put(button, label ? 'E　' + label : '');
    },
    // `text` turns the screen into a message: the sender above, the words below.
    phone(contact, status, text = '') {
      phone.hidden = !contact;
      phone.classList.toggle('message', !!text);
      phone.classList.toggle('ringing', !!contact && !status && !text);
      if (contact) {
        put(phone.querySelector('small'), document.getElementById('tod-clock')?.textContent ?? '');
        put(phone.querySelector('strong'), contact);
        put(phone.querySelector('span'), text || status || 'Příchozí hovor');
      }
    },
    close() {
      document.body.classList.remove('story-cinema');
      root.remove();
    },
  };
}
