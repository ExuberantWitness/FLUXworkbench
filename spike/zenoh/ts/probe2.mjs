import * as zenoh from '@eclipse-zenoh/zenoh-ts';
const s = await zenoh.open(new zenoh.Config());
console.log('session:', s.constructor.name, 'methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter(m=>!m.startsWith('_')).join(' ').slice(0,300));
const got = [];
const sub = await s.declareSubscriber('flux/spike/tsprobe', (sample) => {
  got.push(sample);
  console.log('  recv kind:', typeof sample.payload, Object.getOwnPropertyNames(sample).join(','));
});
await new Promise(r=>setTimeout(r,200));
await s.put('flux/spike/tsprobe', new TextEncoder().encode('hello-ts'));
await new Promise(r=>setTimeout(r,500));
console.log('received:', got.length);
await s.close();
