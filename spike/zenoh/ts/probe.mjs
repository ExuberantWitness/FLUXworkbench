import * as zenoh from '@eclipse-zenoh/zenoh-ts';
console.log('open type:', typeof zenoh.open, '| Config:', typeof zenoh.Config, '| Session?');
// list all top-level
const names = Object.keys(zenoh).filter(k=>!k.startsWith('_'));
console.log('exports:', names.join(' '));
