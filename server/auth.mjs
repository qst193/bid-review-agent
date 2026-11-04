import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

const sessions = new Map();
const cookieName = 'bid_session';
const safeUser = u => u && ({id:u.id, name:u.name, account:u.account, role:u.role, active:u.active !== false});
const digest = (password, salt) => scryptSync(password, salt, 64).toString('hex');
const passwordHash = password => { const salt=randomBytes(16).toString('hex'); return `${salt}:${digest(password,salt)}`; };
const verify = (password, stored) => {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual=Buffer.from(digest(password,salt),'hex'), expected=Buffer.from(hash,'hex');
  return actual.length===expected.length && timingSafeEqual(actual,expected);
};
const reply = (data,status=200,extra={}) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});
async function body(req) {
  const parts=[]; let size=0;
  for await (const part of req) {size+=part.length;if(size>16384) throw new Error('请求过大');parts.push(part);}
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
export function userFromRequest(req,state) {
  const token=(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const session=token && sessions.get(token);
  if (!session || session.expires<Date.now()) return null;
  const user=(state.users || []).find(u=>u.id===session.userId && u.active!==false);
  return user || null;
}
export function canSeeProject(user,project) {
  if (!user) return false;
  if (['super','admin'].includes(user.role)) return true;
  return project.createdBy===user.id || project.owner===user.name || (project.entities || []).some(e=>e.owner===user.name);
}
export async function authRoute(req,url,store) {
  const state=await store.readState();
  const users=state.users || [];
  const p=url.pathname,m=req.method;
  if (p==='/api/auth/status' && m==='GET') return reply({needsSetup:users.length===0,feishuConfigured:false,user:safeUser(userFromRequest(req,state))});
  if (p==='/api/auth/setup' && m==='POST') {
    if (users.length) return reply({error:'管理员已设置'},409);
    const b=await body(req);
    if (!String(b.name||'').trim() || !String(b.account||'').trim() || String(b.password||'').length<10) return reply({error:'填写姓名、账号和至少 10 位密码'},400);
    let created;
    await store.mutate(s=>{if((s.users||[]).length) return;created={id:'u-'+randomBytes(8).toString('hex'),name:String(b.name).trim().slice(0,40),account:String(b.account).trim().slice(0,60),role:'super',active:true,passwordHash:passwordHash(String(b.password)),createdAt:new Date().toISOString()};s.users=[created];});
    return created ? reply({user:safeUser(created)}) : reply({error:'管理员已设置'},409);
  }
  if (p==='/api/auth/login' && m==='POST') {
    const b=await body(req),u=users.find(x=>x.account===String(b.account||'').trim() && x.active!==false);
    if (!u || !verify(String(b.password||''),u.passwordHash)) return reply({error:'账号或密码错误'},401);
    const token=randomBytes(32).toString('hex');
    sessions.set(token,{userId:u.id,expires:Date.now()+12*60*60*1000});
    return reply({user:safeUser(u)},200,{'Set-Cookie':`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`});
  }
  if (p==='/api/auth/logout' && m==='POST') {
    const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(token) sessions.delete(token);
    return reply({ok:true},200,{'Set-Cookie':`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});
  }
  const user=userFromRequest(req,state);
  if (!user) return reply({error:'请先登录'},401);
  if (p==='/api/auth/me' && m==='GET') return reply({user:safeUser(user)});
  if (p==='/api/member-options' && m==='GET') return reply({members:users.filter(u=>u.active!==false).map(u=>({id:u.id,name:u.name}))});
  if (p==='/api/members' && m==='GET') {
    if (!['super','admin'].includes(user.role)) return reply({error:'无权查看成员'},403);
    return reply({members:users.map(safeUser)});
  }
  if (p==='/api/members' && m==='POST') {
    if (!['super','admin'].includes(user.role)) return reply({error:'无权管理成员'},403);
    const b=await body(req),account=String(b.account||'').trim(),name=String(b.name||'').trim(),role=String(b.role||'owner');
    if (!account || !name || String(b.password||'').length<10 || !['owner','admin'].includes(role) || (role==='admin' && user.role!=='super')) return reply({error:'填写姓名、账号、至少 10 位密码及有权限创建的角色'},400);
    if (users.some(x=>x.account===account || x.name===name)) return reply({error:'账号或姓名已存在；姓名须唯一以保证项目隔离'},409);
    const created={id:'u-'+randomBytes(8).toString('hex'),account,name:name.slice(0,40),role,active:true,passwordHash:passwordHash(String(b.password)),createdAt:new Date().toISOString()};
    await store.mutate(s=>{s.users=s.users||[];s.users.push(created);});
    return reply({member:safeUser(created)});
  }
  const memberRoute=p.match(/^\/api\/members\/([^/]+)$/);
  if (memberRoute && m==='PATCH') {
    if (!['super','admin'].includes(user.role)) return reply({error:'无权管理成员'},403);
    const target=users.find(x=>x.id===memberRoute[1]);
    if (!target) return reply({error:'成员不存在'},404);
    if (target.role==='super' || (user.role!=='super' && target.role==='admin')) return reply({error:'无权修改该成员'},403);
    const b=await body(req);
    if (b.role && (!['owner','admin'].includes(b.role) || (b.role==='admin' && user.role!=='super'))) return reply({error:'无权设置该角色'},403);
    if (b.password!==undefined && String(b.password).length<10) return reply({error:'新密码至少 10 位'},400);
    await store.mutate(s=>{const u=s.users.find(x=>x.id===target.id);if(b.role)u.role=b.role;if(b.active!==undefined)u.active=!!b.active;if(b.password)u.passwordHash=passwordHash(String(b.password));});
    return reply({member:safeUser((await store.readState()).users.find(x=>x.id===target.id))});
  }
  return null;
}
