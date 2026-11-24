export function parseCrep(text) {
 const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.trim());
 if(!lines.length || !lines[0].startsWith('CC')) throw new Error('El archivo no tiene una cabecera CREP reconocible (CC).');
 const rows=[], errors=[];
 for(let i=1;i<lines.length;i++){
  const l=lines[i];
  if(l.length!==250||!l.startsWith('DD')){errors.push(`Línea ${i+1}: estructura distinta al reporte CREP de 250 caracteres.`);continue;}
  const date=l.slice(57,65),time=l.slice(168,174),code=l.slice(187,195), amount=l.slice(73,88),client=l.slice(13,27).trim().replace(/^0+(?=\d)/,'');
  if(!/^\d{8}$/.test(code)||!/^\d{15}$/.test(amount)||!/^\d{8}$/.test(date)||!/^\d{6}$/.test(time)){errors.push(`Línea ${i+1}: código, fecha, hora o importe inválido.`);continue;}
  const iso=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  if(new Date(iso+'T00:00:00Z').toISOString().slice(0,10)!==iso||+time.slice(0,2)>23||+time.slice(2,4)>59||+time.slice(4)>59){errors.push(`Línea ${i+1}: fecha u hora fuera de rango.`);continue;}
  rows.push({code,client:client.padStart(8,'0'),account:l.slice(2,13),date:iso,time:time.match(/../g).join(':'),cents:Number(amount),channel:l.slice(152,168).trim(),raw:l});
 }
 const expected=Number(lines[0].slice(22,31)),total=Number(lines[0].slice(31,46));
 if(!Number.isInteger(expected)||expected!==lines.length-1) errors.push('La cantidad de registros no coincide con la cabecera.');
 if(rows.length===lines.length-1&&rows.reduce((s,r)=>s+r.cents,0)!==total)errors.push('La suma de importes no coincide con la cabecera.');
 if(!rows.length&&!errors.length)errors.push('El archivo no contiene cobros.');
 return {rows,errors,expected,total};
}
export const samePayment=(a,b)=>['code','client','account','date','time','channel'].every(k=>a[k]===b[k])&&Number(a.cents)===Number(b.cents);
