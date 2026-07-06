import * as zenoh from '@eclipse-zenoh/zenoh-ts';
const c = new zenoh.Config();
console.log('Config methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter(m=>!m.startsWith('_')).join(','));
// 试几种设值方式
for (const [k,v] of [['mode','"peer"'],['listen','["tcp/127.0.0.1:7448"]'],['connect','[]']]) {
  try { c.insert_json5(k, v); console.log('  insert_json5', k, 'ok'); }
  catch(e){ console.log('  insert_json5', k, 'FAIL', e.message.slice(0,80)); }
}
try {
  const s = await zenoh.open(c);
  console.log('OPEN OK with explicit listen');
  await s.close();
} catch(e){ console.log('OPEN FAIL', e.message.slice(0,150)); }
// 也试 client 模式连一个不存在的 router（看 open 本身能否过）
