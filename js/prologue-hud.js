export function storyHud() {
  const root = document.createElement('div');
  root.className = 'journey-hud';
  root.innerHTML =
    '<div class="journey-heading"><small></small><strong></strong><span></span></div><div class="journey-caption" aria-live="polite"><b></b><p></p></div><button type="button"></button>';
  const phone = document.createElement('aside');
  phone.className = 'journey-phone';
  phone.innerHTML = '<i></i><small>19.58</small><strong></strong><span></span>';
  phone.hidden = true;
  root.append(phone);
  document.body.append(root);
  const [location, title, hint, speaker, line, button] = root.querySelectorAll('small,strong,span,b,p,button');
  function put(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  return {
    root,
    button,
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
        put(phone.querySelector('strong'), contact);
        put(phone.querySelector('span'), status || (contact === 'Máma' ? 'Nová zpráva' : 'Příchozí hovor'));
      }
    },
    close() {
      root.remove();
    }
  };
}
