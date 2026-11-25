// Safe guest-persistent file operations over the existing guest exec channel.
// The helper runs as root inside the VM; host filesystem APIs are never used.
const ROOT = '/root/vm-files';
// The request JSON is passed as one guest exec argv item; Linux limits one argv/env
// string to 128 KiB. Leave headroom for the Python helper and JSON envelope.
const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 1000;

// All traversal is relative to an already-open root dirfd. O_NOFOLLOW is applied
// to every component; operations never resolve symlinks (including final files).
const PYTHON = String.raw`
import os, sys, json, base64, stat, errno
ROOT = '/root/vm-files'
MAX = 64 * 1024
LIMIT = 1000
req = json.loads(sys.argv[1])
def fail(msg): raise ValueError(msg)
def parts(p, allow_root=False):
    if not isinstance(p, str) or '\x00' in p: fail('invalid path')
    if p.startswith('/'):
        if p != '/': fail('absolute paths are forbidden')
        p = ''
    a = [] if p in ('', '.') else p.split('/')
    if any(x in ('..', '.', '') for x in a): fail('invalid path component')
    if any(x == 'dsh-shares' for x in a[:2]) and a[0] == 'mnt': fail('shared paths are forbidden')
    return a
def openroot():
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    return os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
def parent(root, a):
    fd = os.dup(root)
    try:
        for x in a[:-1]:
            n = os.open(x, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd=n
        return fd
    except:
        os.close(fd); raise
def run():
    op=req.get('op'); a=parts(req.get('path',''))
    root=openroot()
    try:
      if op == 'list':
        if not a:
          fd = os.dup(root)
        else:
          pfd = parent(root,a)
          try: fd = os.open(a[-1], os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=pfd)
          finally: os.close(pfd)
        try:
          names=sorted(os.listdir(fd))
          if len(names)>LIMIT: fail('directory entry limit exceeded')
          out=[]
          for n in names:
            st=os.stat(n,dir_fd=fd,follow_symlinks=False)
            out.append({'name':n,'type':'dir' if stat.S_ISDIR(st.st_mode) else ('file' if stat.S_ISREG(st.st_mode) else 'other'),'size':st.st_size if stat.S_ISREG(st.st_mode) else 0,'mtime':int(st.st_mtime*1000)})
          return {'entries':out}
        finally: os.close(fd)
      if op == 'read':
        if not a: fail('cannot read directory')
        fd=parent(root,a)
        try:
          f=os.open(a[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
          try:
            st=os.fstat(f)
            if not stat.S_ISREG(st.st_mode): fail('not a regular file')
            if st.st_size>MAX: fail('file size limit exceeded')
            chunks=[]; total=0
            while True:
              b=os.read(f,min(65536,MAX+1-total))
              if not b: break
              chunks.append(b); total+=len(b)
              if total>MAX: fail('file size limit exceeded')
            return {'data':base64.b64encode(b''.join(chunks)).decode(),'size':total}
          finally: os.close(f)
        finally: os.close(fd)
      if op == 'write':
        if not a: fail('cannot replace root')
        data=base64.b64decode(req.get('data',''),validate=True)
        if len(data)>MAX: fail('file size limit exceeded')
        fd=parent(root,a)
        try:
          flags=os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_TRUNC if req.get('overwrite',True) else os.O_EXCL)
          f=os.open(a[-1],flags,0o600,dir_fd=fd)
          try:
            if not stat.S_ISREG(os.fstat(f).st_mode): fail('not a regular file')
            view=memoryview(data)
            while view: view=view[os.write(f,view):]
          finally: os.close(f)
        finally: os.close(fd)
        return {'size':len(data)}
      if op == 'mkdir':
        if not a: fail('directory already exists')
        fd=parent(root,a)
        try: os.mkdir(a[-1],0o700,dir_fd=fd)
        finally: os.close(fd)
        return {}
      if op == 'rename':
        b=parts(req.get('to',''))
        if not a or not b: fail('cannot rename root')
        p1=parent(root,a); p2=parent(root,b)
        try:
          os.stat(a[-1],dir_fd=p1,follow_symlinks=False)
          os.stat(b[-1],dir_fd=p2,follow_symlinks=False) if req.get('overwrite') else None
          if not req.get('overwrite'):
            try: os.stat(b[-1],dir_fd=p2,follow_symlinks=False); fail('destination exists')
            except FileNotFoundError: pass
          os.rename(a[-1],b[-1],src_dir_fd=p1,dst_dir_fd=p2)
        finally: os.close(p1); os.close(p2)
        return {}
      if op == 'remove':
        if not a: fail('cannot remove root')
        fd=parent(root,a)
        try:
          st=os.stat(a[-1],dir_fd=fd,follow_symlinks=False)
          if stat.S_ISDIR(st.st_mode):
            child=os.open(a[-1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:
              if os.listdir(child): fail('directory is not empty')
            finally: os.close(child)
            os.rmdir(a[-1],dir_fd=fd)
          else: os.unlink(a[-1],dir_fd=fd)
        finally: os.close(fd)
        return {}
      fail('unknown operation')
    finally: os.close(root)
try: print(json.dumps({'ok':True,**run()},separators=(',',':')))
except Exception as e: print(json.dumps({'ok':False,'error':str(e)[:300]},separators=(',',':')))
`;

function validatePath(path) {
  if (typeof path !== 'string' || path.includes('\0')) throw new TypeError('invalid path');
  if (path.startsWith('/') && path !== '/') throw new TypeError('absolute paths are forbidden');
  const p = path === '/' ? '' : path;
  if (p && p.split('/').some((x) => x === '..' || x === '.' || x === '')) throw new TypeError('invalid path component');
  if (p === 'mnt/dsh-shares' || p.startsWith('mnt/dsh-shares/')) throw new TypeError('shared paths are forbidden');
}

/**
 * `exec` must be the existing VM agent command channel, accepting an argv array
 * and resolving to stdout text (or {stdout}). It must not execute on the host.
 */
export class GuestFiles {
  constructor({ exec, maxFileBytes = MAX_FILE_BYTES } = {}) {
    if (typeof exec !== 'function') throw new TypeError('guest exec channel required');
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) throw new TypeError('invalid maxFileBytes');
    this.exec = exec;
    this.maxFileBytes = maxFileBytes;
  }
  async call(op, fields = {}) {
    if (fields.path !== undefined) validatePath(fields.path);
    if (fields.to !== undefined) validatePath(fields.to);
    if (op === 'write' && (typeof fields.data !== 'string' || Buffer.byteLength(fields.data, 'base64') > this.maxFileBytes)) throw new TypeError('file size limit exceeded');
    const req = { op, ...fields, maxBytes: this.maxFileBytes };
    const result = await this.exec(['python3', '-c', PYTHON, JSON.stringify(req)], { cwd: '/' });
    const text = typeof result === 'string' ? result : result?.stdout;
    let parsed;
    try { parsed = JSON.parse(String(text ?? '')); } catch { throw new Error('invalid guest file response'); }
    if (!parsed.ok) throw new Error(parsed.error || 'guest file operation failed');
    return parsed;
  }
  async list(path = '') { return (await this.call('list', { path })).entries; }
  async read(path) { return this.call('read', { path }); }
  async write(path, data, { overwrite = true } = {}) { return this.call('write', { path, data, overwrite }); }
  async mkdir(path) { return this.call('mkdir', { path }); }
  async rename(path, to, { overwrite = false } = {}) { return this.call('rename', { path, to, overwrite }); }
  async remove(path) { return this.call('remove', { path }); }
}

export const guestFilesLimits = Object.freeze({ root: ROOT, maxFileBytes: MAX_FILE_BYTES, maxListEntries: MAX_LIST_ENTRIES });
