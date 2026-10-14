export class TickgroveClient {
 constructor(private token:string,private url='http://127.0.0.1:8787') {}
 async command<T=unknown>(method:string,params:Record<string,unknown>={},idempotency_key?:string):Promise<T>{
  const response=await fetch(this.url+'/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.token}`},body:JSON.stringify({method,params,idempotency_key})});const body=await response.json();if(!response.ok)throw Error(body.error);return body
 }
}

// Existing imports keep working with the same command protocol.
export { TickgroveClient as TradingClient };
