// Static-safe, local-only email drafting. No form submission, API calls or storage.
const root = document.querySelector('[data-partners-page]');
if (root) {
  const email = 'zhangmh@datafluxdynamics.ltd';
  const canonical = 'https://www.datafluxdynamics.ltd/partners/';
  const role = root.querySelector('#partner-role');
  const draft = root.querySelector('#partner-draft');
  const status = root.querySelector('#partner-status');
  const mail = root.querySelector('[data-partner-email]');
  const fields = ['name', 'capability', 'example', 'availability', 'contact'];
  const value = id => root.querySelector('#partner-' + id).value.trim();
  const say = text => { status.textContent = text; status.hidden = !text; };
  function update() {
    const selected = role.selectedOptions[0];
    root.querySelector('#partner-capability').placeholder = selected.dataset.prompt;
    const message = [
      '你好，我希望与数瀚衍动交流以下合作：', '',
      '合作方向：' + selected.textContent,
      ...(value('name') ? ['个人或机构：' + value('name')] : []),
      ...(value('capability') ? ['可提供能力：' + value('capability')] : []),
      ...(value('example') ? ['代表案例或链接：' + value('example')] : []),
      ...(value('availability') ? ['所在地与可投入时间：' + value('availability')] : []),
      '联系方式：' + (value('contact') || '请通过本邮件回复'), '',
      '来自：' + canonical
    ].join('\n');
    draft.value = message;
    mail.href = 'mailto:' + email + '?subject=' + encodeURIComponent('合作联系 / ' + selected.textContent + (value('name') ? ' / ' + value('name') : '')) + '&body=' + encodeURIComponent(message);
    say('');
  }
  role.addEventListener('change', update);
  for (const field of fields) root.querySelector('#partner-' + field).addEventListener('input', update);
  for (const link of root.querySelectorAll('[data-partner-role]')) {
    link.addEventListener('click', () => {
      role.value = link.dataset.partnerRole;
      update();
      // Follow the normal anchor even if script enhancement fails.
      setTimeout(() => role.focus({ preventScroll: true }), 0);
    });
  }
  function syncHash() {
    const linkedRole = location.hash.slice(1);
    if ([...role.options].some(option => option.value === linkedRole)) {
      role.value = linkedRole;
      update();
    }
  }
  window.addEventListener('hashchange', syncHash);
  syncHash();
  mail.addEventListener('click', () => { say('请在邮件中确认发送。如未打开邮件软件，可复制简介发送至 ' + email + '。'); });
  root.querySelector('[data-partner-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(draft.value);
      say('合作简介已复制。');
    } catch {
      root.querySelector('[data-partner-preview]').open = true;
      draft.focus(); draft.select();
      say('请复制已选中的合作简介。');
    }
  });
  const share = root.querySelector('[data-partner-share]');
  share.addEventListener('click', async () => {
    const out = root.querySelector('[data-share-status]');
    try { await navigator.clipboard.writeText(canonical); out.textContent = '链接已复制，可以直接转发。'; }
    catch { out.textContent = '请手动复制链接：' + canonical; }
  });
  share.hidden = false;
  root.querySelector('[data-partner-composer]').hidden = false;
  update();
  root.dataset.ready = 'true';
}
