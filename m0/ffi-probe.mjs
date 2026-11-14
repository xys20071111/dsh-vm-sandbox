// 探测 koffi 对 char**（argv/envp 数组）参数的可用声明方式。
import koffi from 'koffi';
const lib = koffi.load(`${process.env.HOME}/opt/libkrun/lib/libkrun.so.1`);

const attempts = [
  ['A: const char *argv[] (inline)', () => lib.func('int32_t probe(uint32_t a, const char *b, const char *argv[], const char *envp[])')],
  ['B: const char *[] (suffix on type)', () => lib.func('int32_t probe(uint32_t a, const char *b, const char *[] argv, const char *[] envp)')],
  ['C: str argv[]', () => lib.func('int32_t probe(uint32_t a, const char *b, str argv[], str envp[])')],
  ['D: pointer type object', () => {
    const P = koffi.pointer('const char *');
    return lib.func('int32_t probe', 'int32_t', ['uint32_t', 'const char *', P, P]);
  }],
  ['E: fixed array type', () => {
    const A = koffi.array('const char *', 8);
    return lib.func('int32_t probe', 'int32_t', ['uint32_t', 'const char *', A, A]);
  }],
];
for (const [name, make] of attempts) {
  try {
    const f = make();
    console.log(`PARSE-OK: ${name}`);
    // 探测调用形式：用真实 krun 符号没有 probe，跳过调用；解析通过即候选。
  } catch (e) {
    console.log(`parse fail: ${name}: ${String(e).slice(0, 100)}`);
  }
}
