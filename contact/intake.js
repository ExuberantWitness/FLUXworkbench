// Shared static enhancement for private trial applications and meeting enquiries.
const email = 'zhangmh@datafluxdynamics.ltd';
for (const form of document.querySelectorAll('[data-contact-compose]')) {
  if (form.dataset.ready) continue;
  const mail = form.querySelector('[data-contact-email]');
  const preview = form.querySelector('[data-contact-preview]');
  const message = form.querySelector('[data-contact-message]');
  const copy = form.querySelector('[data-contact-copy]');
  const status = form.querySelector('[data-contact-status]');
  const get = name => form.elements[name]?.value.trim() || '';
  const say = text => { status.textContent = text; status.hidden = !text; };
  function update() {
    const trial = form.dataset.contactCompose === 'trial';
    const subject = trial ? 'Flux Workbench 试用申请' + (get('hardware') ? ' / ' + get('hardware') : '') : 'DataFlux 产品交流 / ' + get('topic');
    const rows = trial ? ['你好，我希望申请 Flux Workbench 产品试用。', '', '身份：' + get('role'), '当前阶段：' + get('stage'), ...(get('hardware') ? ['硬件：' + get('hardware')] : []), ...(get('task') ? ['希望完成的任务：' + get('task')] : [])] : ['你好，我想预约一次 DataFlux Dynamics 产品交流。', '', '主题：' + get('topic'), '方便时间：' + get('timing'), ...(get('context') ? ['背景：' + get('context')] : [])];
    message.value = [...rows, '', '请通过本邮件回复。'].join('\n');
    mail.href = 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(message.value);
    say('');
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', event => { event.preventDefault(); mail.click(); });
  mail.addEventListener('click', event => {
    if (!form.reportValidity()) { event.preventDefault(); return; }
    say('请在邮件中确认发送。如未打开邮件软件，可复制内容发送至 ' + email + '。');
  });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(message.value); say('内容已复制。'); }
    catch { preview.open = true; message.focus(); message.select(); say('请复制已选中的内容。'); }
  });
  preview.hidden = false; copy.hidden = false;
  update(); form.dataset.ready = 'true';
}
