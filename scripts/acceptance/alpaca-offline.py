"""Actual Rust adapter against localhost venue mock; no external orders or credentials."""
import http.server,json,os,pathlib,socket,subprocess,tempfile,threading,time,urllib.request,urllib.error,urllib.parse,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2];orders={};posts={};lock=threading.Lock()
class Venue(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def reply(self,status,data=None):
        self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers()
        if data is not None:self.wfile.write(json.dumps(data).encode())
    def do_POST(self):
        assert self.path=='/orders';data=json.loads(self.rfile.read(int(self.headers['Content-Length'])));client=data['client_order_id'];posts[client]=posts.get(client,0)+1
        if client=='reject':self.reply(422,{'code':42210000,'message':'insufficient buying power'});return
        orders[client]={'id':str(uuid.uuid4()),'client_order_id':client,'status':'new','qty':str(data['qty']),'filled_qty':'0'}
        if client=='lost-response':self.close_connection=True;self.connection.shutdown(socket.SHUT_RDWR);return
        self.reply(200,orders[client])
    def do_GET(self):
        query=urllib.parse.urlparse(self.path);client=urllib.parse.parse_qs(query.query)['client_order_id'][0]
        if client not in orders:self.reply(404,{'message':'not found'});return
        self.reply(200,orders[client])
    def do_DELETE(self):
        id=self.path.split('/')[-1]
        for order in orders.values():
            if order['id']==id:order['status']='canceled'
        self.reply(204)
venue=http.server.ThreadingHTTPServer(('127.0.0.1',0),Venue);threading.Thread(target=venue.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='trading-alpaca-offline-') as directory:
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    token=str(uuid.uuid4());env={**os.environ,'TRADING_ROOT':str(ROOT),'TRADING_DATA_DIR':directory,'TRADING_TOKEN':token,'TRADING_BIND':f'127.0.0.1:{port}','TRADING_ALPACA_MOCK_URL':f'http://127.0.0.1:{venue.server_port}','ALPACA_API_KEY':'offline-fixture','ALPACA_API_SECRET':'offline-fixture'};url=f'http://127.0.0.1:{port}';service=None
    def start():
        global service
        service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:urllib.request.urlopen(url+'/health');return
            except OSError:time.sleep(.1)
        raise RuntimeError('startup failed')
    def call(method,p):
        request=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':p}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
        try:
            with urllib.request.urlopen(request) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    def order(id):return {'client_order_id':id,'symbol':'SPY','side':'buy','qty':'1','type':'market','time_in_force':'day'}
    start()
    try:
        p=order('reject');assert call('orders.submit',p)[0]==400;status,value=call('orders.submit',p);assert value['state']=='rejected' and posts['reject']==1,value
        p=order('lost-response');assert call('orders.submit',p)[0]==400;status,value=call('orders.submit',p);assert value['state']=='unknown' and posts['lost-response']==1
        orders['lost-response']['status']='partially_filled';orders['lost-response']['filled_qty']='0.4';status,value=call('orders.reconcile',{'client_order_id':'lost-response'});assert status==200 and value['filled_qty']=='0.4'
        assert call('orders.cancel',{'order_id':value['id']})[0]==200;status,value=call('orders.reconcile',{'client_order_id':'lost-response'});assert value['status']=='canceled' and value['filled_qty']=='0.4'
        service.terminate();service.wait(5);start();status,value=call('orders.submit',p);assert value['state']=='canceled' and posts['lost-response']==1
        p=order('filled');status,value=call('orders.submit',p);assert status==200;orders['filled'].update(status='filled',filled_qty='1');assert call('orders.reconcile',{'client_order_id':'filled'})[0]==200
        orders['filled'].update(status='partially_filled',filled_qty='.5');assert call('orders.reconcile',{'client_order_id':'filled'})[0]==400
        changed=order('filled');changed['qty']='2';assert call('orders.submit',changed)[0]==400
        print(json.dumps({'ok':True,'venue':'localhost HTTP mock','realCredentials':False,'externalOrders':False,'knownRejection':True,'lostResponseNoResubmit':True,'partialFillThenCancel':True,'restartReconciliation':True,'fillRegressionRejected':True,'idConflictRejected':True,'submitCounts':posts},indent=2))
    finally:
        if service:service.terminate();service.wait(5)
venue.shutdown()
