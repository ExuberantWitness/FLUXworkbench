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
  function update() {
    const selected = role.selectedOptions[0];
    root.querySelector('#partner-capability').placeholder = selected.dataset.prompt;
    const message = [
      '你好，我希望与数瀚衍动交流以下合作：', '',
      '合作方向：' + selected.textContent,
      '个人或机构：' + (value('name') || '待补充'),
      '可提供能力：' + (value('capability') || '待补充'),
      '代表案例或链接：' + (value('example') || '待补充，可另附脱敏资料'),
      '所在地与可投入时间：' + (value('availability') || '待补充'),
      '联系方式：' + (value('contact') || '请通过本邮件回复'), '',
      '来自：' + canonical
    ].join('\n');
    draft.value = message;
    mail.href = 'mailto:' + email + '?subject=' + encodeURIComponent('合作联系 / ' + selected.textContent + ' / ' + (value('name') || '待补充')) + '&body=' + encodeURIComponent(message);
    status.textContent = '草稿已更新，尚未发送。请在邮件软件中确认发送，或复制后手动发送。';
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
  mail.addEventListener('click', () => { status.textContent = '请在邮件软件中确认发送。若没有打开邮件软件，请复制简介后手动发送；本站尚未提交资料。'; });
  root.querySelector('[data-partner-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(draft.value);
      status.textContent = '简介已复制。请粘贴到邮件并发送至 ' + email + '；资料尚未提交。';
    } catch {
      draft.focus(); draft.select();
      status.textContent = '浏览器未允许复制。已选中草稿，请手动复制并通过邮件发送。';
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
