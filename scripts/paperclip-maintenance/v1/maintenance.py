#!/usr/bin/env python3
"""Bounded read-only Paperclip maintenance collector. No remote mutation capability."""
import argparse,contextlib,fcntl,hashlib,json,os,re,shlex,sqlite3,stat as statmod,time,urllib.request,urllib.error
from pathlib import Path
VERSION='1.0.2'
LIMITS={'seconds':60,'files':500,'bytes':8*1024*1024,'api_calls':80,'deep_cases':5,'handoffs':3,'issues':20,'nodes':20000}
DENY=re.compile(r'(auth\.json|credentials|secrets?|\.env|id_rsa|id_ed25519|\.sqlite|\.db|backup|snapshot)',re.I)
TEXT={'.md','.py','.js','.ts','.sh','.toml','.service','.conf','.path'}
PYTHON_INTERPRETER_RE=re.compile(r'^(?:/.*/)?python(?:3(?:\.\d+)?)?$')
ALLOWED_EXEC_EXTS={'.sh','.py','.js'}
SUPPORTED_PYTHON_FLAGS={'-u','-B','-E','-s','-S','-O','-OO'}
def parse_service_exec(directive,val):
 val=val.strip()
 if not val:return None,None
 if directive in ('WorkingDirectory','PathChanged'):
  ref=val.removeprefix('-').strip()
  if ref.startswith('/'):return ref,None
  return None,'service_path_relative_or_invalid'
 m=re.match(r'^([@\-+!]+)\s*(.*)$',val)
 if m:val=m.group(2)
 if not val:return None,None
 try:tokens=shlex.split(val,posix=True)
 except Exception:return None,'service_exec_parse_error'
 if not tokens:return None,None
 for t in tokens:
  if any(c in t for c in (';','&','|','>','<','$','`')):return None,'service_exec_shell_or_variable_unsupported'
 first=tokens[0]
 if first.startswith('/') and Path(first).suffix in ALLOWED_EXEC_EXTS:return first,None
 binary_name=Path(first).name
 if PYTHON_INTERPRETER_RE.match(binary_name) and first.startswith('/'):
  idx=1
  while idx<len(tokens):
   arg=tokens[idx]
   if arg in ('-c','-m'):return None,'service_exec_inline_or_module_unsupported'
   if arg.startswith('-'):
    if arg not in SUPPORTED_PYTHON_FLAGS:return None,'service_exec_option_unsupported'
   else:
    if arg.startswith('/') and Path(arg).suffix in ALLOWED_EXEC_EXTS:return arg,None
    return None,'service_exec_script_unsupported_or_relative'
   idx+=1
  return None,'service_exec_no_script_target'
 return None,'service_exec_unsupported_binary'
def digest(value):return hashlib.sha256(value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode()).hexdigest()
def project(v,keys):return {k:v.get(k) for k in keys}
class Limit(Exception):pass
class ReadFailure(Exception):
 def __init__(self,code):self.code=str(code)
class Budget:
 def __init__(self,limits=None):self.limits={**LIMITS,**(limits or {})};self.start=time.monotonic();self.used={'files':0,'bytes':0,'api_calls':0,'nodes':0}
 def take(self,key,n=1):
  if time.monotonic()-self.start>self.limits['seconds']:raise Limit('seconds')
  if self.used[key]+n>self.limits[key]:raise Limit(key)
  self.used[key]+=n
class Store:
 def __init__(self,path):
  self.path=Path(path);self.path.mkdir(parents=True,exist_ok=True,mode=0o700)
  self.db=sqlite3.connect(self.path/'state.sqlite',timeout=1)
  self.db.executescript('''CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,meta TEXT,hash TEXT,stamp TEXT,status TEXT,seen REAL,checked REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS findings(key TEXT PRIMARY KEY,source TEXT,code TEXT,first REAL,last REAL,count INTEGER);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,mode TEXT,start REAL,end REAL,status TEXT,metrics TEXT);
CREATE TABLE IF NOT EXISTS intents(key TEXT PRIMARY KEY,target TEXT,expected TEXT,status TEXT,result TEXT);''')
 def get(self,k,default=None):
  r=self.db.execute('SELECT value FROM kv WHERE key=?',(k,)).fetchone();return json.loads(r[0]) if r else default
 def put(self,k,v):
  self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)',(k,json.dumps(v)));self.db.commit()
 def finding(self,source,code):
  key=digest([source,code]);now=time.time();exists=self.db.execute('SELECT 1 FROM findings WHERE key=?',(key,)).fetchone()
  self.db.execute('INSERT INTO findings VALUES (?,?,?,?,?,1) ON CONFLICT(key) DO UPDATE SET last=excluded.last,count=count+1',(key,source,code,now,now));self.db.commit();return not exists
 def source(self,id,meta,h=None,stamp=None,status='readable'):
  if status=='unchanged_cached':status='readable'
  old=self.db.execute('SELECT hash,stamp,checked,status FROM sources WHERE id=?',(id,)).fetchone()
  changed=not old or (h is not None and h!=old[0]) or status!=(old[3] if old else None)
  self.db.execute('INSERT INTO sources(id,meta,hash,stamp,status,seen,checked) VALUES (?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,hash=COALESCE(excluded.hash,sources.hash),stamp=excluded.stamp,status=excluded.status,seen=excluded.seen', (id,json.dumps(meta),h,stamp,status,time.time()))
  self.db.commit();return changed
 def intent(self,key,target,expected):
  # Durable fence precedes any caller-owned authorized action; duplicate intent never dispatches.
  try:self.db.execute('INSERT INTO intents VALUES (?,?,?,\'unknown\',NULL)',(key,target,json.dumps(expected)));self.db.commit();return True
  except sqlite3.IntegrityError:return False
 def reconcile(self,key,observed):
  r=self.db.execute('SELECT expected,status FROM intents WHERE key=?',(key,)).fetchone()
  if not r:raise ValueError('unknown intent')
  status='confirmed' if json.loads(r[0])==observed else 'deferred_unknown'
  self.db.execute('UPDATE intents SET status=?,result=? WHERE key=?',(status,json.dumps(observed),key));self.db.commit();return status
 def review_details(self):
  result=[]
  for id in self.get('review_candidates',[]):
   row=self.db.execute('SELECT hash,meta FROM sources WHERE id=?',(id,)).fetchone()
   if not row:continue
   meta=json.loads(row[1]);suffix=Path(id).suffix
   kind=('json_string_sha256' if 'revision' in meta else 'json_projection_sha256') if id.startswith('api:') else ('service_path_projection_sha256' if suffix in {'.service','.path','.conf'} else 'configuration_projection_sha256' if suffix=='.toml' else 'raw_bytes_sha256')
   result.append({'source':id,'hash':row[0],'hash_kind':kind,'metadata':meta})
  return result
 def lock(self):return state_lock(self.path)

@contextlib.contextmanager
def state_lock(path):
 # The CLI takes this before opening SQLite, including schema initialization.
 # Kernel ownership; never unlink or reclaim the mutex using PID or age.
 path=Path(path);path.mkdir(parents=True,exist_ok=True,mode=0o700)
 with open(path/'maintenance.lock','a+') as f:
  try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:yield False;return
  try:yield True
  finally:fcntl.flock(f,fcntl.LOCK_UN)

class API:
 def __init__(self,budget):self.budget=budget;self.base=os.environ['PAPERCLIP_API_URL'].rstrip('/').removesuffix('/api')
 def get(self,path):
  self.budget.take('api_calls');r=urllib.request.Request(self.base+'/api/'+path,headers={'Authorization':'Bearer '+os.environ['PAPERCLIP_API_KEY']})
  try:
   with urllib.request.urlopen(r,timeout=min(10,max(.1,self.budget.limits['seconds']-(time.monotonic()-self.budget.start)))) as f:
    cap=self.budget.limits['bytes']-self.budget.used['bytes'];raw=f.read(cap+1);self.budget.take('bytes',len(raw));return json.loads(raw)
  except urllib.error.HTTPError as e:raise ReadFailure('http_'+str(e.code)) from None
  except (OSError,ValueError):raise ReadFailure('temporary_read_failure') from None
class Collector:
 def __init__(self,store,budget,api,company,mode='daily',roots=(),owner=None):
  self.workspace_root=None;self.owner=owner;self.s=store;self.b=budget;self.api=api;self.company=company;self.mode=mode;self.roots=set(map(str,roots));self.skillroots=set();self.instructionroots=set();self.queue=[];self.visited=set();self.changes=[];self.new_findings=[];self.remaining=[];self.issues=[];self.refs=set(self.s.get('known_document_refs',[]));self.start=time.time()
  self.queue=self.s.get('file_remaining',[]);self.visited={i['path'] for i in self.queue}
 def gap(self,id,code,origin):
  self.s.source(id,{'origin':origin,'loader':id},status=code)
  if self.s.finding(id,code):self.new_findings.append({'source':id,'code':code})
 def data(self,path,projection):
  try:
   v=self.api.get(path);safe=projection(v)
   if self.s.source('api:'+path,{'origin':'running API','loader':'GET /api/'+path},digest(safe),status='readable'):self.changes.append('api:'+path)
   return v
  except ReadFailure as e:self.gap('api:'+path,e.code,'running API');return None
 def add(self,path,origin,kind='rule'):
  p=Path(os.path.abspath(path));id=str(p)
  if DENY.search(id) or DENY.search(os.path.realpath(p)):self.gap(id,'excluded_sensitive_or_backup',origin);return
  if id not in self.visited:
   self.visited.add(id);self.queue.append({'path':id,'origin':origin,'kind':kind})
 def ancestors(self,path):
  p=Path(path)
  for a in [p,*p.parents]:
   if (a/'AGENTS.md').exists():self.add(a/'AGENTS.md','project parent rules')
 def metadata(self):
  prefix='companies/'+self.company+'/'
  agents=self.data(prefix+'agents',lambda vs:[{**project(v,['id','status','adapterType']), 'config':project(v.get('adapterConfig') or {},['model','engine','modelReasoningEffort','instructionsFilePath','cwd','instructionsBundleMode'])} for v in vs]) or []
  for a in agents:
   if self.workspace_root:
    workspace=Path(self.workspace_root)/a['id']
    if workspace.is_dir():self.roots.add(str(workspace));self.ancestors(workspace)
    else:self.gap(str(workspace),'workspace_unavailable','registered agent workspace directory')
   cfg=a.get('adapterConfig') or {};p=cfg.get('instructionsFilePath')
   if p:self.add(p,'agent:'+a['id']);self.roots.add(str(Path(p).parent));self.instructionroots.add(str(Path(p).parent))
   else:self.gap('agent:'+a['id'],'instructions_path_unavailable','agent API')
   cwd=cfg.get('cwd');
   if cwd:self.ancestors(cwd)
   # Do not traverse env values or use denied per-agent config fallback.
  projects=self.data(prefix+'projects',lambda vs:[project(v,['id','updatedAt']) for v in vs]) or []
  for p in projects:
   folders=[(p.get('codebase') or {}).get('effectiveLocalFolder')]
   folders += [w.get('cwd') for w in p.get('workspaces',[])]
   for folder in filter(None,folders):self.roots.add(folder);self.ancestors(folder)
  skills=self.data(prefix+'skills',lambda vs:[project(v,['id','sourceRef','packageVersion','fileInventory']) for v in vs]) or []
  for skill in skills:
   loc=skill.get('sourceLocator') or skill.get('sourcePath')
   if loc and str(loc).startswith('/'):
    self.roots.add(loc);self.skillroots.add(str(Path(loc).absolute()))
    for f in skill.get('fileInventory',[]):self.add(Path(loc)/f['path'],'skill:'+skill['id'],'skill')
   else:self.gap('skill:'+skill['id'],'source_unavailable','skill API')
  routines=self.data(prefix+'routines',lambda vs:[project(v,['id','status','assigneeAgentId','parentIssueId','version','concurrencyPolicy','catchUpPolicy','activityGatePolicy','triggers']) for v in vs]) or []
  for r in routines:
   self.references(r.get('description') or '',None,'routine:'+r['id'])
   self.s.source('routine:'+r['id'],{'origin':'routine API','loader':'GET /api/'+prefix+'routines','owner':r.get('assigneeAgentId')},digest(project(r,['description','status','version','triggers'])))
  self.data(prefix+'costs/by-agent',lambda vs:[project(v,['agentId','inputTokens','outputTokens','cachedInputTokens','subscriptionRunCount','costCents']) for v in vs])
  issue_base=prefix+'issues?view=compact&limit=1000&sortField=id&sortDir=asc'
  scan=self.s.get('issue_scan') or {'after_id':None,'watermarks':{},'metadata':{}}
  self.s.put('issue_scan',scan);issues=None
  while True:
   after_id=scan.get('after_id')
   issue_path=issue_base+('&afterId='+after_id if after_id else '')
   page=self.data(issue_path,lambda vs:[project(v,['id','status','updatedAt','monitorNextCheckAt','monitorWakeCount','executionRunId','originKind','originId']) for v in vs])
   if page is None:
    self.remaining.append('issue_scan:'+str(after_id or 'start'));break
   if page and after_id and page[-1]['id']<=after_id:
    self.gap('api:'+issue_base,'issue_pagination_no_progress','running API')
    self.remaining.append('issue_scan:'+str(after_id));break
   for issue in page:
    scan['watermarks'][issue['id']]=issue['updatedAt']
    scan['metadata'][issue['id']]=project(issue,['id','identifier','status','updatedAt','monitorNextCheckAt','monitorWakeCount','executionRunId','blockedByIssueIds','executionBlocker','originKind','originId','assigneeAgentId'])
   if len(page)<1000:
    issues=list(scan['metadata'].values());break
   scan['after_id']=page[-1]['id']
   self.s.put('issue_scan',scan)
  if issues is not None:
   for i in issues:
    self.issues.append(project(i,['id','identifier','status','updatedAt','monitorNextCheckAt','monitorWakeCount','executionRunId','blockedByIssueIds','executionBlocker','originKind','originId','assigneeAgentId']))
   old_wm=self.s.get('issue_watermarks',{});new_wm=scan['watermarks']
   unreviewed=self.s.get('issue_unreviewed',{})
   # Legacy migration: if issue_remaining had items, seed unreviewed with known watermarks
   legacy_remaining=self.s.get('issue_remaining',[])
   for lid in legacy_remaining:
    if lid in new_wm and lid not in unreviewed:unreviewed[lid]=new_wm[lid]
   # Prune issues no longer in active issue set
   unreviewed={id:rev for id,rev in unreviewed.items() if id in new_wm}
   # Any new issue or issue with changed updatedAt watermark becomes an unreviewed candidate
   for id,rev in new_wm.items():
    if id not in old_wm or old_wm[id]!=rev:unreviewed[id]=rev
    elif id not in unreviewed and id not in self.s.get('issue_acknowledged',{}):unreviewed[id]=rev
   self.s.put('issue_unreviewed',unreviewed);self.s.put('issue_watermarks',new_wm);self.s.put('issue_metadata',self.issues)
   self.s.put('issue_remaining',list(unreviewed.keys()))
   self.s.put('issue_scan',None)
  # API capabilities not granted remain visible, no filesystem/DB fallback.
  configs=self.data(prefix+'agent-configurations',lambda v:[project(a,['id','updatedAt','revision']) for a in v] if isinstance(v,list) else project(v,['version']))
  if isinstance(configs,list):
   for a in configs:
    cfg=a.get('adapterConfig') or {}
    for key in ('instructionsFilePath','cwd'):
     value=cfg.get(key)
     if value and isinstance(value,str) and value.startswith('/'):
      if key=='cwd':self.roots.add(value);self.ancestors(value)
      else:self.add(value,'authorized configuration:'+a['id'])
    # Provider-home values only if API actually supplies plain absolute path.
    for key,binding in (cfg.get('env') or {}).items():
     if key in ('CODEX_HOME','CLAUDE_CONFIG_DIR','OPENCODE_CONFIG_DIR') and isinstance(binding,dict):
      home=binding.get('value')
      if isinstance(home,str) and home.startswith('/'):
       self.roots.add(str(Path(home)/'skills'));self.add(Path(home)/'config.toml','provider-home projection','projection')
      else:self.gap('provider-home:'+a['id']+':'+key,'provider_home_redacted','configuration API')
  runs=self.data(prefix+'heartbeat-runs?limit=200&summary=true',lambda vs:[project(v,['id','status','startedAt','finishedAt','invocationSource','agentId']) for v in vs])
  if runs is not None:
   self.s.put('recent_run_metadata',[project(v,['id','status','startedAt','finishedAt','invocationSource','agentId']) for v in runs])
   if len(runs)>=200:self.gap('run-window','recent_200_only_no_supported_pagination','run API')
 def references(self,text,base,origin):
  text=re.sub(r'```.*?```','',text,flags=re.S)
  children=[]
  for issue,key in re.findall(r'/api/issues/([a-f0-9-]+)/documents/([\w-]+)',text):self.refs.add('issues/'+issue+'/documents/'+key)
  if base:
   for rel in re.findall(r'\]\(([^)]+)\)',text):
    rel=rel.split('#')[0]
    if rel and not re.match(r'\w+:|/AIW/|/api/',rel):
     anchor=Path(base)
     if rel.startswith(('references/','scripts/','templates/')):
      for candidate in [anchor,*anchor.parents]:
       if (candidate/'SKILL.md').is_file():anchor=candidate;break
     p=Path(rel) if rel.startswith('/') else anchor/rel
     if p.suffix in TEXT:
      self.add(p,origin+' reference','reference');children.append(os.path.abspath(p))
  return children
 def discover_files(self):
  # Enumerate metadata only; recursion never follows symlink dirs. Cursor survives budgets.
  frontier=self.s.get('discovery_remaining',[])
  for root in sorted(self.roots):
   if root not in frontier:frontier.append(root)
  done=set()
  while frontier:
   root=frontier[0]
   try:self.b.take('nodes')
   except Limit:self.s.put('discovery_remaining',frontier);self.remaining+=frontier;raise
   frontier.pop(0)
   if root in done:continue
   done.add(root)
   if DENY.search(root):continue
   try:
    with os.scandir(root) as it:entries=sorted(it,key=lambda e:e.name)
   except OSError:self.gap(root,'directory_unavailable','discovery');continue
   for e in entries:
    try:
     if e.is_dir(follow_symlinks=False):
      if e.name not in {'.git','node_modules','data','logs','sessions','file-sync','runs','__pycache__'} and not DENY.search(e.name):frontier.append(e.path)
     elif e.name in {'AGENTS.md','SKILL.md'} or (Path(e.name).suffix in TEXT and any(os.path.abspath(e.path).startswith(r+'/') for r in self.skillroots|self.instructionroots)):
      known=any(os.path.abspath(e.path).startswith(r+'/') for r in self.skillroots|self.instructionroots)
      if known:self.add(e.path,'dynamic skill package' if e.name not in {'AGENTS.md','SKILL.md'} else 'dynamic root discovery')
      else:
       stat=e.stat(follow_symlinks=False);self.s.source(os.path.abspath(e.path),{'origin':'workspace scoped rule','loader':'only when matching cwd/subscope enters','classification':'scoped_or_historical_not_loaded'},stamp=str((stat.st_mtime_ns,stat.st_size)),status='scope_dependent_not_loaded')
    except OSError:self.gap(e.path,'temporary_stat_failure','discovery')
  self.s.put('discovery_remaining',[])
 def file(self,item):
  p=Path(os.path.abspath(item['path']));id=str(p)
  if item['origin'].startswith('dynamic root discovery') and not any(id.startswith(r+'/') for r in self.skillroots|self.instructionroots):
   self.s.source(id,{'origin':'historical discovery reference','loader':'not an active runtime loader','classification':'scope_dependent_or_historical'},status='scope_dependent_not_loaded');return
  meta={'origin':item['origin'],'loader':id,'kind':item['kind'],'classification':('runtime-provider-copy' if '/tmp/paperclip-ai-' in id else 'project-scope-dependent' if item['origin'].startswith('project') else 'package-resource-not-proven-loaded' if item['origin']=='dynamic skill package' else 'scope-dependent-not-proven-loaded' if item['origin']=='dynamic root discovery' else 'active-reference')}
  try:
   stat=p.stat()
   if not statmod.S_ISREG(stat.st_mode):raise ReadFailure('non_regular_source')
   stamp=str((stat.st_mtime_ns,stat.st_size,stat.st_ino));old=self.s.db.execute('SELECT hash,stamp FROM sources WHERE id=?',(id,)).fetchone()
   if old and old[1]==stamp and self.mode=='daily':
    self.s.source(id,meta,old[0],stamp,'unchanged_cached')
    for child in self.s.get('file_refs:'+digest(id),[]):self.add(child,item['origin']+' reference','reference')
    for gap in self.s.get('file_gaps:'+digest(id),[]):self.gap(gap,'config_secret_projection_required','service')
    return
   self.b.take('files');self.b.take('bytes',stat.st_size)
   if stat.st_size>1024*1024:self.gap(id,'file_too_large',item['origin']);return
   with p.open('rb') as f:raw=f.read(stat.st_size+1)
   if len(raw)>stat.st_size:raise ReadFailure('changed_during_read')
   text=raw.decode('utf-8',errors='replace')
   # Service/configuration content is projected; no full credential-bearing config hash/persistence.
   if p.suffix in {'.service','.path','.conf'}:
    gaps=[]
    paths=re.findall(r'^(?:WorkingDirectory|EnvironmentFile)=(-?[^\n]+)',text,re.M)
    for ref in paths:
     ref=ref.removeprefix('-').strip()
     if ref.startswith('/'):
      if 'EnvironmentFile='+ref in text or 'EnvironmentFile=-'+ref in text:self.gap(ref,'config_secret_projection_required','service');gaps.append(ref)
      else:self.ancestors(ref)
    matches=re.findall(r'^(WorkingDirectory|ExecStart|ExecStartPre|ExecStartPost|PathChanged)=([^\n]+)',text,re.M)
    safe_execs=[]
    for directive,val in matches:
     script_ref,gap_code=parse_service_exec(directive,val)
     if script_ref:
      safe_execs.append(script_ref)
      if Path(script_ref).suffix in ALLOWED_EXEC_EXTS:self.add(script_ref,'service executable reference','reference')
     elif gap_code:
      self.gap(id+':gap:'+gap_code,gap_code,'service')
      gaps.append(gap_code)
    self.s.put('file_gaps:'+digest(id),gaps)
    h=digest(safe_execs)
   elif p.suffix=='.toml':
    safe=re.findall(r'^(?:model|model_provider|sandbox_mode|approval_policy)\s*=\s*"([\w.-]+)"',text,re.M);h=digest(safe)
   else:
    h=digest(raw);children=self.references(text,p.parent,item['origin']);self.s.put('file_refs:'+digest(id),children)
   if self.s.source(id,meta,h,stamp):self.changes.append(id)
  except (OSError,ReadFailure) as e:self.gap(id,e.code if isinstance(e,ReadFailure) else 'file_unavailable',item['origin'])
 def documents(self):
  pending=sorted(self.refs | set(self.s.get('document_remaining',[])));listed=set();done=set()
  while pending:
   path=pending[0];issue=path.split('/')[1]
   try:
    if issue not in listed:
     try:
      docs=self.api.get('issues/'+issue+'/documents');listed.add(issue)
      for d in docs:self.refs.add('issues/'+issue+'/documents/'+d['key'])
     except ReadFailure as e:self.gap('api:issues/'+issue+'/documents',e.code,'document listing')
    v=self.api.get(path);body=v.get('body','');self.references(body,None,'API document')
    if self.s.source('api:'+path,{'origin':'rule reference','loader':'GET /api/'+path,'revision':v.get('latestRevisionId')},digest(body)):self.changes.append('api:'+path)
   except ReadFailure as e:self.gap('api:'+path,e.code,'rule reference')
   except Limit:self.s.put('document_remaining',pending);self.remaining+=pending;raise
   done.add(path);pending.pop(0)
   for ref in sorted(self.refs):
    if ref not in pending and ref not in done:pending.append(ref)
  self.s.put('document_remaining',[]);self.s.put('known_document_refs',sorted(self.refs))
 def inspect(self):
  # Deep work queue is persistent and fair; collector never claims semantic acceptance.
  pending=self.s.get('review_remaining',[])
  for id in self.changes:
   if id not in pending:pending.append(id)
  if self.mode=='weekly':
   for (id,) in self.s.db.execute("SELECT id FROM sources WHERE status='readable' ORDER BY checked,id"):
    if id not in pending:pending.append(id)
  pending=[id for id in pending if (self.s.db.execute('SELECT status FROM sources WHERE id=?',(id,)).fetchone() or ['historical_not_observed'])[0]=='readable']
  claims=self.s.get('review_claims',{});selected=[]
  if self.owner:
   owners={c['owner'] for c in claims.values() if c['owner']!=self.owner}
   for owner in owners:
    try:
     run=self.api.get('heartbeat-runs/'+owner)
     ex=run.get('execution') or {} if isinstance(run,dict) else {}
     if isinstance(run,dict) and run.get('finishedAt') and run.get('status') in {'succeeded','failed','cancelled','interrupted','timed_out'} and ex.get('phase') in {'completed','failed'} and not any(ex.get(k) for k in ('retryAt','recoveryOwner','successorRunId')):
      claims={id:c for id,c in claims.items() if c['owner']!=owner}
    except ReadFailure:pass  # No takeover of unverifiable active/recovery owner.
  for id in pending:
   if id not in claims or claims[id]['owner']==self.owner:
    selected.append(id)
    if self.owner:claims[id]={'owner':self.owner,'hash':self.s.db.execute('SELECT hash FROM sources WHERE id=?',(id,)).fetchone()[0]}
   if len(selected)>=self.b.limits['deep_cases']:break
  self.s.put('review_claims',claims);self.s.put('review_candidates',selected)
  # Remain pending until responsible reviewer supplies hash-bound evidence via reviewed command.
  self.s.put('review_remaining',pending)
  self.s.put('handoff_limit',self.b.limits['handoffs'])
  unreviewed=self.s.get('issue_unreviewed',{})
  chosen=list(unreviewed.keys())[:self.b.limits['issues']]
  self.s.put('issue_candidates',chosen)
  self.s.put('issue_remaining',list(unreviewed.keys()))
  # Safe machine checks, not duplicate remediation tasks.
  lookup={i['id']:i for i in self.issues}
  for id in chosen:
   i=lookup.get(id,{})
   if i.get('monitorNextCheckAt') and i.get('status') in {'done','cancelled'}:
    if self.s.finding('issue:'+id,'monitor_on_terminal_issue'):self.new_findings.append({'source':'issue:'+id,'code':'monitor_on_terminal_issue'})
 def run(self):
  with self.s.lock() as acquired:
   if not acquired:return {'status':'overlap_skipped','effects':0}
   return self._run_locked()
 def _run_locked(self):
  self.s.put('collector_owner',self.owner)
  self.s.db.execute('UPDATE runs SET status=\'interrupted\',end=? WHERE end IS NULL',(time.time(),));self.s.db.commit()
  id=self.s.db.execute('INSERT INTO runs(mode,start,status) VALUES (?,?,?)',(self.mode,self.start,'running')).lastrowid;self.s.db.commit()
  status='completed';failure=None
  try:
   self.metadata();self.discover_files()
   saved=self.s.get('file_remaining',[])
   for item in saved:
    if item['path'] not in self.visited:self.queue.insert(0,item);self.visited.add(item['path'])
   kept=[];historical=set(self.s.get('historical_reference_candidates',[]))
   for item in self.queue:
    path=os.path.abspath(item['path'])
    if item['origin'].startswith('dynamic root discovery') and not any(path.startswith(r+'/') for r in self.skillroots|self.instructionroots):historical.add(path)
    else:kept.append(item)
   self.s.put('historical_reference_candidates',sorted(historical))
   self.queue=kept;self.s.put('file_remaining',self.queue)
   while self.queue:
    self.b.take('nodes',0)
    self.file(self.queue[0]);self.queue.pop(0);self.s.put('file_remaining',self.queue)
   self.documents();self.inspect()
  except Limit as e:status='bounded';failure=str(e);self.s.put('file_remaining',self.queue);self.remaining += [i['path'] for i in self.queue]
  except Exception as e:
   # No exception text (may contain secrets). Safe type-only report, durable queue.
   status='read_failure';failure='internal_'+type(e).__name__;self.s.put('file_remaining',self.queue)
  finally:
   self.s.put('known_document_refs',sorted(self.refs));self.s.put('collector_owner',None)
   if status=='completed':
    self.s.db.execute("UPDATE sources SET status='historical_not_observed' WHERE seen<?",(self.start,));self.s.db.commit()
   # Even bounded run queues already detected diffs; never silently lose them.
   pending=self.s.get('review_remaining',[])
   pending=list(dict.fromkeys(pending+self.changes))
   if status=='completed':pending=[id for id in pending if (self.s.db.execute('SELECT status FROM sources WHERE id=?',(id,)).fetchone() or ['historical_not_observed'])[0]=='readable']
   self.s.put('review_remaining',pending)
   metrics={**self.b.used,'seconds':round(time.monotonic()-self.b.start,4),'changed':len(set(self.changes)),'new_findings':len(self.new_findings),'remaining_discovery':len(self.s.get('discovery_remaining',[])),'remaining_files':len(self.s.get('file_remaining',[])),'remaining_documents':len(self.s.get('document_remaining',[])),'remaining_semantic_review':len(self.s.get('review_remaining',[])),'remaining_issue_scan':bool(self.s.get('issue_scan')),'model_calls':0,'inference_tokens':0,'agent_run_tokens':'not measured by collector','limit':failure}
   self.s.db.execute('UPDATE runs SET end=?,status=?,metrics=? WHERE id=?',(time.time(),status,json.dumps(metrics),id));self.s.db.commit()
   return {'version':VERSION,'status':status,'run':id,'metrics':metrics,'new_findings':self.new_findings,'review_candidates':self.s.get('review_candidates',[]),'review_details':self.s.review_details(),'issue_candidates':self.s.get('issue_candidates',[])}
def progress_decision(previous,current,now,stall_seconds=30):
 # Known waits preserve lifecycle gates; ordinary unchanged markers are bounded locally.
 if current.get('gate') in {'checkout','recovery','hold','human','dependency'}:return 'defer_affected_path'
 if current.get('wait_until',0)>now:return 'known_wait'
 if previous.get('marker')!=current.get('marker'):return 'progress'
 if now-current.get('last_progress',now)>=stall_seconds:return 'stop_affected_path'
 return 'within_progress_window'
def main():
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['daily','weekly','status','reviewed','release']);p.add_argument('--state',required=True);p.add_argument('--root',action='append',default=[]);p.add_argument('--source');p.add_argument('--hash');p.add_argument('--evidence');a=p.parse_args()
 with state_lock(a.state) as acquired:
  if not acquired:
   if a.mode in {'daily','weekly'}:print(json.dumps({'status':'overlap_skipped','effects':0}));return
   raise SystemExit(3)
  return _main_locked(a)
def _main_locked(a):
 s=Store(a.state)
 try:return _execute_locked(a,s)
 finally:s.db.close()
def _execute_locked(a,s):
 if a.mode=='release':
  claims=s.get('review_claims',{});s.put('review_claims',{id:c for id,c in claims.items() if c['owner']!=os.environ.get('PAPERCLIP_RUN_ID')})
  return
 if a.mode=='status':
  print(json.dumps({'sources':s.db.execute('SELECT count(*) FROM sources').fetchone()[0],'review_remaining':s.get('review_remaining',[]),'issue_remaining':s.get('issue_remaining',[]),'issue_candidates':s.get('issue_candidates',[]),'review_details':s.review_details(),'last_run':s.db.execute('SELECT status,metrics FROM runs ORDER BY id DESC LIMIT 1').fetchone()},indent=2));return
 if a.mode=='reviewed':
  if not all([a.source,a.hash,a.evidence]):raise SystemExit('source, hash and evidence required')
  if a.source.startswith('issue:'):
   issue_id=a.source.removeprefix('issue:')
   unreviewed=s.get('issue_unreviewed',{})
   if issue_id not in unreviewed:
    ack=s.get('issue_acknowledged',{})
    if ack.get(issue_id)==a.hash:return  # idempotent duplicate acknowledgement
    raise SystemExit('issue not unreviewed or already removed')
   if unreviewed[issue_id]!=a.hash:raise SystemExit('issue revision changed; evidence not applied')
   unreviewed.pop(issue_id)
   s.put('issue_unreviewed',unreviewed)
   ack=s.get('issue_acknowledged',{})
   ack[issue_id]=a.hash
   s.put('issue_acknowledged',ack)
   s.put('issue_remaining',list(unreviewed.keys()))
   s.put('issue_candidates',[x for x in s.get('issue_candidates',[]) if x!=issue_id])
   s.put('evidence:'+digest(a.source),{'hash':a.hash,'evidence':a.evidence})
   return
  row=s.db.execute('SELECT hash FROM sources WHERE id=?',(a.source,)).fetchone()
  if not row or row[0]!=a.hash:raise SystemExit('source changed; evidence not applied')
  claim=s.get('review_claims',{}).get(a.source)
  if claim and claim['owner']!=os.environ.get('PAPERCLIP_RUN_ID'):raise SystemExit('source claimed by another run')
  claims=s.get('review_claims',{});claims.pop(a.source,None);s.put('review_claims',claims)
  s.db.execute('UPDATE sources SET checked=? WHERE id=?',(time.time(),a.source));s.db.commit();s.put('review_remaining',[x for x in s.get('review_remaining',[]) if x!=a.source]);s.put('evidence:'+digest(a.source),{'hash':a.hash,'evidence':a.evidence});return
 b=Budget();api=API(b);c=Collector(s,b,api,os.environ['PAPERCLIP_COMPANY_ID'],a.mode,a.root,os.environ.get('PAPERCLIP_RUN_ID'))
 c.roots.add(str(Path.cwd()));c.ancestors(Path.cwd())
 if Path.cwd().parent.name=='workspaces':c.workspace_root=str(Path.cwd().parent)
 # Roots supplied from allowed runtime; current provider home never its auth/session files.
 home=os.environ.get('CODEX_HOME')
 if home:
  c.roots.add(str(Path(home)/'skills'));c.skillroots.add(str(Path(home)/'skills'));c.add(Path(home)/'config.toml','current provider config','projection')
 for root in ('/etc/systemd/system',):
  for f in Path(root).glob('*paperclip*'):
   if f.is_file():c.add(f,'service definition','projection')
  for f in Path(root).glob('paperclip*.d/*.conf'):c.add(f,'service override','projection')
 result=c._run_locked();print(json.dumps(result,indent=2));raise SystemExit(0 if result['status'] in {'completed','bounded','overlap_skipped'} else 1)
if __name__=='__main__':main()
