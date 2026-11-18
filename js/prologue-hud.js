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
  root.append(timer, skip, travel);
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
      skip.hidden = !on;
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
    phone(contact, status) {
      phone.hidden = !contact;
      if (contact) {
        put(phone.querySelector('small'), document.getElementById('tod-clock')?.textContent ?? '');
        put(phone.querySelector('strong'), contact);
        put(phone.querySelector('span'), status || (contact === 'Máma' ? 'Nová zpráva' : 'Příchozí hovor'));
      }
    },
    close() {
      document.body.classList.remove('story-cinema');
      root.remove();
    },
  };
}
