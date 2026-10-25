import json,os,sqlite3,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from maintenance import *
BASE=Path(__file__).resolve().parent.parent/'test-data';BASE.mkdir(exist_ok=True)
class FakeAPI:
 def __init__(self,values=None):self.values=values or {};self.calls=[]
 def get(self,path):
  self.calls.append(path);v=self.values.get(path,{} if path.endswith('agent-configurations') else [])
  if isinstance(v,Exception):raise v
  return v
class Tests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory(dir=BASE);self.root=Path(self.tmp.name);self.s=Store(self.root/'state')
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def c(self,api=None,**limits):
  c=Collector(self.s,Budget(limits),api or FakeAPI(),'fixture','daily',[self.root/'sources']);c.instructionroots.add(str(self.root/'sources'));return c
 def test_new_changed_unchanged_and_reference(self):
  r=self.root/'sources';r.mkdir();f=r/'AGENTS.md';f.write_text('[ref](RULE.md)');(r/'RULE.md').write_text('rule')
  a=self.c();a.discover_files()
  while a.queue:a.file(a.queue.pop(0))
  self.assertEqual(len(a.changes),2)
  b=self.c();b.discover_files();b.file(b.queue.pop(0));self.assertEqual(b.changes,[]);self.assertEqual(b.b.used['bytes'],0)
  f.write_text('new rule');c=self.c();c.discover_files();c.file(c.queue.pop(0));self.assertEqual(c.changes,[str(f)])
 def test_optional_gap_continues_and_dedup(self):
  r=self.root/'sources';r.mkdir();(r/'AGENTS.md').write_text('[missing](missing.md)')
  first=self.c().run();second=self.c().run()
  self.assertEqual(first['status'],'completed');self.assertEqual(second['metrics']['new_findings'],0)
  self.assertTrue(self.s.db.execute("SELECT 1 FROM sources WHERE status='file_unavailable'").fetchone())
 def test_temporary_read_then_real_state_change(self):
  a=FakeAPI({'companies/fixture/projects':ReadFailure('temporary_read_failure')});first=self.c(a).run()
  second=self.c(a).run();self.assertEqual(second['metrics']['new_findings'],0)
  r=self.root/'sources';r.mkdir();f=r/'AGENTS.md';f.write_text('real changed state')
  a.values['companies/fixture/projects']=[];third=self.c(a).run()
  self.assertEqual(third['status'],'completed');self.assertIn(str(f),self.s.get('review_remaining'))
 def test_dependency_only_defers_affected_path(self):
  decision=progress_decision({}, {'gate':'dependency','marker':1,'last_progress':0},100)
  self.assertEqual(decision,'defer_affected_path');self.assertEqual(self.c().run()['status'],'completed')
  self.assertEqual(progress_decision({'marker':1},{'marker':2,'last_progress':100},100),'progress')
 def test_lock_daily_weekly_real_concurrent_process(self):
  code="from maintenance import Store; import sys,json; from pathlib import Path; s=Store(sys.argv[1]);\nwith s.lock() as ok: print(json.dumps({'acquired':ok}))"
  with self.s.lock() as ok:
   self.assertTrue(ok)
   p=subprocess.run([sys.executable,'-c',code,str(self.s.path)],cwd=Path(__file__).parent,capture_output=True,text=True)
   self.assertEqual(p.returncode,0);self.assertFalse(json.loads(p.stdout)['acquired'])
   self.assertEqual(self.c().run()['status'],'overlap_skipped')
  with self.s.lock() as ok:self.assertTrue(ok)
 def test_cli_overlap_precedes_sqlite_initialization(self):
  script=Path(__file__).with_name('maintenance.py')
  for mode in ['daily','weekly']:
   with self.subTest(mode=mode),self.s.lock() as ok:
    self.assertTrue(ok);self.s.db.execute('BEGIN EXCLUSIVE')
    try:
     before=(self.s.path/'state.sqlite').read_bytes();inode=(self.s.path/'maintenance.lock').stat().st_ino
     p=subprocess.run([sys.executable,str(script),mode,'--state',str(self.s.path)],capture_output=True,text=True,timeout=5)
     self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(json.loads(p.stdout),{'status':'overlap_skipped','effects':0})
     self.assertEqual((self.s.path/'state.sqlite').read_bytes(),before)
     self.assertEqual((self.s.path/'maintenance.lock').stat().st_ino,inode)
    finally:self.s.db.rollback()
 def test_cli_acknowledgement_cannot_touch_a_busy_database(self):
  with self.s.lock() as ok:
   self.assertTrue(ok);self.s.db.execute('BEGIN EXCLUSIVE')
   try:
    p=subprocess.run([sys.executable,str(Path(__file__).with_name('maintenance.py')),'reviewed','--state',str(self.s.path)],capture_output=True,text=True,timeout=5)
    self.assertEqual(p.returncode,3,p.stderr);self.assertNotIn('OperationalError',p.stderr)
   finally:self.s.db.rollback()
 def test_candidate_hash_contract_distinguishes_raw_bytes_and_projections(self):
  values=[('/rules/AGENTS.md',{},digest(b'rule'),'raw_bytes_sha256'),
   ('api:issues/id/documents/rule',{'revision':'r1'},digest('rule'),'json_string_sha256'),
   ('api:companies/id/agents',{},digest([]),'json_projection_sha256'),
   ('/service/a.conf',{},digest(['/safe/script.py']),'service_path_projection_sha256'),
   ('/config/a.toml',{},digest(['model']),'configuration_projection_sha256')]
  for id,meta,h,kind in values:self.s.source(id,meta,h)
  self.s.put('review_candidates',[x[0] for x in values]);details=self.s.review_details()
  self.assertEqual([(x['source'],x['hash'],x['hash_kind']) for x in details],[(x[0],x[2],x[3]) for x in values])
  self.assertNotEqual(values[0][2],values[1][2])
 def test_progress_not_age_and_known_wait(self):
  old={'marker':3}
  self.assertEqual(progress_decision(old,{'marker':3,'last_progress':0,'wait_until':200},100),'known_wait')
  self.assertEqual(progress_decision(old,{'marker':4,'last_progress':0},100),'progress')
  self.assertEqual(progress_decision(old,{'marker':3,'last_progress':0},100),'stop_affected_path')
  for gate in ['checkout','recovery','hold','human']:
   self.assertEqual(progress_decision(old,{'marker':3,'last_progress':0,'gate':gate},100),'defer_affected_path')
 def test_unknown_write_no_replay(self):
  self.assertTrue(self.s.intent('op','fixture',{'revision':'r2'}));writes=1
  self.assertFalse(self.s.intent('op','fixture',{'revision':'r2'}))
  self.assertEqual(self.s.reconcile('op',{'revision':'r1'}),'deferred_unknown');self.assertFalse(self.s.intent('op','fixture',{}));self.assertEqual(writes,1)
  self.assertEqual(self.s.reconcile('op',{'revision':'r2'}),'confirmed');self.assertFalse(self.s.intent('op','fixture',{}))
 def test_interruption_process_lock_and_resume_changed_state(self):
  r=self.root/'sources';r.mkdir();f=r/'AGENTS.md';f.write_text('before')
  code="from maintenance import *; import sys,os; s=Store(sys.argv[1]);\nwith s.lock() as ok:\n s.put('file_remaining',[{'path':sys.argv[2],'origin':'interrupted','kind':'rule'}]); s.db.execute(\"INSERT INTO runs(mode,start,status) VALUES ('daily',0,'running')\"); s.db.commit(); os._exit(17)"
  p=subprocess.run([sys.executable,'-c',code,str(self.s.path),str(f)],cwd=Path(__file__).parent,capture_output=True)
  self.assertEqual(p.returncode,17);f.write_text('after real change');v=self.c().run()
  self.assertEqual(v['status'],'completed');self.assertEqual(self.s.get('file_remaining'),[])
  self.assertEqual(self.s.db.execute('SELECT status FROM runs ORDER BY id LIMIT 1').fetchone()[0],'interrupted')
  self.assertEqual(self.s.db.execute('SELECT hash FROM sources WHERE id=?',(str(f),)).fetchone()[0],digest(b'after real change'))
 def test_budget_resume_cursor_no_starvation(self):
  r=self.root/'sources';r.mkdir()
  for name in ['AGENTS.md','SKILL.md']:(r/name).write_text(name)
  a=self.c(files=1).run();self.assertEqual(a['status'],'bounded');self.assertEqual(a['metrics']['remaining_files'],1)
  (r/'AGENTS.md').write_text('changed AGAIN')
  b=self.c(files=1).run();self.assertEqual(b['status'],'bounded')
  self.assertTrue(self.s.db.execute('SELECT 1 FROM sources WHERE id=?',(str(r/'SKILL.md'),)).fetchone())
 def test_secret_exclusion_and_safe_exception(self):
  sentinel='SYNTH_AUTH_DO_NOT_PERSIST';f=self.root/'auth.json';f.write_text(sentinel)
  c=self.c();c.add(f,'fixture');v=c.run()
  self.assertNotIn(sentinel,json.dumps(v));self.assertNotIn(sentinel,(self.s.path/'state.sqlite').read_bytes().decode('latin1'))
 def test_weekly_rotation_and_hash_bound_evidence(self):
  for id in ['one','two','three']:self.s.source(id,{'origin':'fixture'},digest(id))
  c=self.c();c.mode='weekly';c.b.limits['deep_cases']=1;c.inspect();self.assertEqual(len(self.s.get('review_candidates')),1)
  id=self.s.get('review_candidates')[0];self.s.db.execute('UPDATE sources SET checked=? WHERE id=?',(time.time(),id));self.s.db.commit();self.s.put('review_remaining',[x for x in self.s.get('review_remaining') if x!=id])
  c=self.c();c.mode='weekly';c.b.limits['deep_cases']=1;c.inspect();self.assertNotEqual(self.s.get('review_candidates')[0],id)
 def test_denial_no_fallback(self):
  api=FakeAPI({'companies/fixture/agent-configurations':ReadFailure('http_403')});self.c(api).run()
  self.assertEqual(api.calls.count('companies/fixture/agent-configurations'),1)
  self.assertTrue(self.s.db.execute("SELECT 1 FROM sources WHERE status='http_403'").fetchone())
 def test_review_claim_no_foreign_takeover_and_terminal_readback(self):
  self.s.source('source',{'origin':'fixture'},digest('v'));self.s.put('review_remaining',['source'])
  a=self.c();a.owner='owner-one';a.inspect();self.assertEqual(self.s.get('review_candidates'),['source'])
  api=FakeAPI({'heartbeat-runs/owner-one':ReadFailure('http_403')});b=self.c(api);b.owner='owner-two';b.inspect();self.assertEqual(self.s.get('review_candidates'),[])
  api.values['heartbeat-runs/owner-one']={'status':'running'};b.inspect();self.assertEqual(self.s.get('review_candidates'),[])
  api.values['heartbeat-runs/owner-one']={'status':'cancelled','finishedAt':'2026-10-14','execution':{'phase':'recovery_needed'}};b.inspect();self.assertEqual(self.s.get('review_candidates'),[])
  api.values['heartbeat-runs/owner-one']={'status':'cancelled','finishedAt':'2026-10-14','execution':{'phase':'failed','recoveryOwner':None}};b.inspect();self.assertEqual(self.s.get('review_candidates'),['source'])
 def test_historical_workspace_rules_metadata_only(self):
  r=self.root/'archive';r.mkdir();(r/'SKILL.md').write_text('[many](many.md)')
  c=self.c();c.roots.add(str(r));c.discover_files();self.assertNotIn(str(r/'SKILL.md'),[x['path'] for x in c.queue]);self.assertEqual(self.s.db.execute('SELECT status FROM sources WHERE id=?',(str(r/'SKILL.md'),)).fetchone()[0],'scope_dependent_not_loaded')
 def test_path_normalization_deduplicates_reference_cycle(self):
  c=self.c();c.add(self.root/'a'/'..'/'b.md','fixture');c.add(self.root/'b.md','fixture');self.assertEqual(len(c.queue),1)
 def test_cached_config_keeps_secret_gap_visible(self):
  f=self.root/'fixture.service';f.write_text('[Service]\nEnvironmentFile=/fixture/private.env\nExecStart=/safe/tool\n')
  a=self.c();a.add(f,'fixture','projection');a.run();b=self.c();b.add(f,'fixture','projection');b.run()
  self.assertEqual(self.s.db.execute('SELECT status FROM sources WHERE id=?',('/fixture/private.env',)).fetchone()[0],'config_secret_projection_required');self.assertEqual(b.b.used['files'],0)
 def test_removed_source_preserved_as_historical(self):
  r=self.root/'sources';r.mkdir();f=r/'AGENTS.md';f.write_text('initial');self.c().run();f.unlink();v=self.c().run()
  self.assertEqual(self.s.db.execute('SELECT status FROM sources WHERE id=?',(str(f),)).fetchone()[0],'historical_not_observed');self.assertNotIn(str(f),self.s.get('review_remaining'));self.assertIsNone(self.s.get('collector_owner'))
 def test_package_relative_reference_from_nested_doc(self):
   root=self.root/'pkg';root.mkdir();(root/'SKILL.md').write_text('skill');(root/'references').mkdir();(root/'references'/'leaf.md').write_text('leaf')
   c=self.c();c.references('[leaf](references/leaf.md)',root/'references','fixture');self.assertEqual(c.queue[0]['path'],str(root/'references'/'leaf.md'))
 def test_examples_not_active_references(self):
   c=self.c();c.references('```md\n[example](references/example.md)\n```',self.root,'fixture');self.assertEqual(c.queue,[])
 def test_missing_document_once_per_run_and_other_document_continues(self):
   missing='issues/111/documents/missing';good='issues/111/documents/good'
   api=FakeAPI({missing:ReadFailure('http_404'),good:{'body':'okay','latestRevisionId':'r1'},'issues/111/documents':[]})
   c=self.c(api);c.refs={missing,good};c.documents();self.assertEqual(api.calls.count(missing),1);self.assertEqual(self.s.get('document_remaining'),[])
   self.assertTrue(self.s.db.execute('SELECT 1 FROM sources WHERE id=?',('api:'+good,)).fetchone())
 def test_collector_issue_candidate_retention_and_hash_bound_ack(self):
   issues=[{'id':'issue-1','identifier':'ISS-1','updatedAt':'2026-10-14T00:00:00Z','status':'in_progress'}]
   api=FakeAPI({'companies/fixture/issues?view=compact&limit=1000&sortField=id&sortDir=asc':issues})
   c1=self.c(api);r1=c1.run()
   self.assertEqual(r1['issue_candidates'],['issue-1'])
   self.assertEqual(self.s.get('issue_candidates'),['issue-1'])
   self.assertEqual(self.s.get('issue_remaining'),['issue-1'])
   c2=self.c(api);r2=c2.run()
   self.assertEqual(r2['issue_candidates'],['issue-1'])
   self.assertEqual(self.s.get('issue_remaining'),['issue-1'])
   cmd=[sys.executable,str(Path(__file__).parent/'maintenance.py'),'reviewed','--state',str(self.s.path),'--source','issue:issue-1','--hash','wrong-hash','--evidence','ev1']
   p=subprocess.run(cmd,capture_output=True,text=True)
   self.assertNotEqual(p.returncode,0)
   self.assertIn('issue revision changed',p.stderr)
   self.assertEqual(self.s.get('issue_candidates'),['issue-1'])
   cmd_ok=[sys.executable,str(Path(__file__).parent/'maintenance.py'),'reviewed','--state',str(self.s.path),'--source','issue:issue-1','--hash','2026-10-14T00:00:00Z','--evidence','ev-ok']
   p_ok=subprocess.run(cmd_ok,capture_output=True,text=True)
   self.assertEqual(p_ok.returncode,0)
   self.assertEqual(self.s.get('issue_unreviewed'),{})
   self.assertEqual(self.s.get('issue_remaining'),[])
   self.assertEqual(self.s.get('issue_candidates'),[])
   p_dup=subprocess.run(cmd_ok,capture_output=True,text=True)
   self.assertEqual(p_dup.returncode,0)
   c3=self.c(api);r3=c3.run()
   self.assertEqual(r3['issue_candidates'],[])
   issues[0]['updatedAt']='2026-10-15T12:00:00Z'
   c4=self.c(api);r4=c4.run()
   self.assertEqual(r4['issue_candidates'],['issue-1'])
   self.assertEqual(self.s.get('issue_unreviewed'),{'issue-1':'2026-10-15T12:00:00Z'})
   p_old=subprocess.run(cmd_ok,capture_output=True,text=True)
   self.assertNotEqual(p_old.returncode,0)
   self.assertIn('issue revision changed',p_old.stderr)
   self.assertEqual(self.s.get('issue_candidates'),['issue-1'])
 def test_issue_metadata_paginates_before_pruning_pending_candidates(self):
  ids=[f'00000000-0000-0000-0000-{i:012d}' for i in range(1001)]
  rows=[{'id':i,'updatedAt':'2026-10-14T00:00:00Z','status':'in_progress'} for i in ids]
  base='companies/fixture/issues?view=compact&limit=1000&sortField=id&sortDir=asc'
  api=FakeAPI({base:rows[:1000],base+'&afterId='+ids[999]:rows[1000:]})
  result=self.c(api).run()
  self.assertEqual(len(self.s.get('issue_unreviewed')),1001)
  self.assertEqual(len(self.s.get('issue_watermarks')),1001)
  self.assertIn(base+'&afterId='+ids[999],api.calls)
  self.assertEqual(result['status'],'completed')
 def test_incomplete_issue_scan_preserves_state_and_resumes_after_read_failure(self):
  ids=[f'00000000-0000-0000-0000-{i:012d}' for i in range(1001)]
  rows=[{'id':i,'updatedAt':'2026-10-14T00:00:00Z','status':'in_progress'} for i in ids]
  base='companies/fixture/issues?view=compact&limit=1000&sortField=id&sortDir=asc'
  after=base+'&afterId='+ids[999]
  old='ffffffff-ffff-ffff-ffff-ffffffffffff'
  self.s.put('issue_watermarks',{old:'old-revision'})
  self.s.put('issue_unreviewed',{old:'old-revision'})
  self.s.put('issue_remaining',[old])
  api=FakeAPI({base:rows[:1000],after:ReadFailure('http_403')})
  first=self.c(api).run()
  self.assertEqual(first['metrics']['remaining_issue_scan'],True)
  self.assertEqual(self.s.get('issue_watermarks'),{old:'old-revision'})
  self.assertEqual(self.s.get('issue_unreviewed'),{old:'old-revision'})
  self.assertEqual(self.s.get('issue_scan')['after_id'],ids[999])
  api.values[after]=rows[1000:]
  second=self.c(api).run()
  self.assertEqual(second['metrics']['remaining_issue_scan'],False)
  self.assertEqual(len(self.s.get('issue_watermarks')),1001)
  self.assertEqual(self.s.get('issue_scan'),None)
 def test_service_exec_parser_forms_and_safe_gaps(self):
   service_content="""[Service]
ExecStart=/usr/bin/python3 /allowed/maintenance.py
ExecStartPre=+/usr/bin/python3.11 -u /allowed/guard.py
ExecStartPost=-/safe/post.sh
PathChanged=/allowed/trigger.path
WorkingDirectory=/allowed/work
EnvironmentFile=/secret/creds.env
ExecStartPre=+/usr/bin/python3 -c "import secret; token='foo'"
ExecStartPre=/usr/bin/python3 -m unittest
ExecStartPost=/usr/bin/python3 --unknown-option /allowed/bar.py
ExecStartPre=/bin/sh -c /allowed/script.sh
"""
   f=self.root/'test.service';f.write_text(service_content)
   c=self.c();c.file({'path':str(f),'origin':'service','kind':'projection'})
   added_paths=[x['path'] for x in c.queue]
   self.assertIn('/allowed/maintenance.py',added_paths)
   self.assertIn('/allowed/guard.py',added_paths)
   self.assertIn('/safe/post.sh',added_paths)
   self.assertNotIn('/secret/creds.env',added_paths)
   self.assertNotIn('import secret',added_paths)
   gaps=[g['code'] for g in c.new_findings]
   self.assertIn('service_exec_inline_or_module_unsupported',gaps)
   self.assertIn('service_exec_option_unsupported',gaps)
   self.assertIn('service_exec_unsupported_binary',gaps)
   self.assertIn('config_secret_projection_required',gaps)
   db_text=(self.s.path/'state.sqlite').read_bytes().decode('latin1',errors='ignore')
   self.assertNotIn('import secret',db_text)
   self.assertNotIn('token=\'foo\'',db_text)
if __name__=='__main__':unittest.main(verbosity=2)
if __name__=='__main__':unittest.main(verbosity=2)
