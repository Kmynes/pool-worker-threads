import { Observable } from "rxjs";
import { PoolWorker, PoolWorkerParams, ResMessage } from "./pool-worker";
import { WaitingQueue } from "./waiting-queue";

export class WorkerPool {
    private static vmCode:string = `
        const vm = require('vm');
        const { parentPort } = require('worker_threads');
        var lastMessageDate;
        const postMessage = (data, desc) => {
            if (!desc) {
                const now = Date.now();
                const processingDuration = lastMessageDate - now;
                lastMessageDate = now;
                var desc = {
                    latest:false,
                    processingDuration
                };
            }
            const ret = {
                data,
                desc:desc
            };
            parentPort.postMessage(ret);
        };
        parentPort.on('message', async ({ executionCode, workerData }) => {
            this.workerData = workerData;
            this.postMessage = postMessage;
            const start = Date.now();
            lastMessageDate = start;
            const script = vm.createScript(executionCode);
            const result = await script.runInThisContext();
            const desc = {
                processingDuration:Date.now() - start,
                latest:true
            }
            this.postMessage(result, desc);
        });
    `;
    private workers:PoolWorker[];
    private _isDead:boolean = false;
    private _queue:WaitingQueue;
    private _strict:boolean;
    get isDead():boolean {
        return this._isDead;
    }

    constructor(public size:number, strict?:boolean) { 
        if (typeof size !== 'number')
            throw new Error('[size] must be the type of number!');

        this.workers = [];
        for (let i = 0; i < size; i++)
            this.workers.push(this._createWorker());

        this._queue = new WaitingQueue();
        this._strict = strict || false;
    }

    private _addWorkerHooks(worker:PoolWorker) {
        worker.on("ready", (worker) => {
            this._queue.emit("worker-ready", worker);
        });

        worker.once("exit", code => {
            if (this._isDead || code == 0)
              return;

            this.replace(worker);
            worker.terminate();
            worker.removeAllListeners();
        });
    }

    private _createWorker() {
        const worker = new PoolWorker(WorkerPool.vmCode, {
            stdout:true,
            stderr:true,
            stdin:true,
            eval:true
        });
        this._addWorkerHooks(worker);
        return worker; 
    }

    private _removeWorker(workerId:number):void {
        const worker = this.workers.find(w => w.id === workerId);
        if (!worker)
            throw new Error(`Unexpected error can't find worker ${workerId}`);

        this.replace(worker);
        worker.terminate();
        worker.removeAllListeners();
    }

    private replace(worker:PoolWorker):void {
        const i = this.workers.indexOf(worker);
        if (i > 0)
            this.workers[i] = this._createWorker();
        else
            throw new Error(`Unexpected error can't find worker [${worker.id}] in list`);
    }

    exec<WorkerDataIn, WorkerDataOut>(
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>)
        :Observable<WorkerDataOut> {
        if (this._isDead)
            throw new Error(`This pool was destroyed, create an other one`);
        const worker = this.workers.find(w => !w.busy);
        var oTask:Observable<ResMessage<WorkerDataOut>>;
        if (worker)
            oTask = worker.runTask<WorkerDataIn, WorkerDataOut>(params); 
        else
            oTask = this._queue.runTask<WorkerDataIn, WorkerDataOut>(params);
        return new Observable<WorkerDataOut>(subscriber => {
            oTask
                .subscribe({
                    next:result => {
                        subscriber.next(result.data);
                        if (result.desc.latest)
                            subscriber.complete();
                    },
                    error:(ret:{workerId:number, error:Error}) => {
                        if (this._strict)
                            throw ret.error;
                        else
                            console.error(ret.error);
                        this._removeWorker(ret.workerId);
                    },
                    complete: () => {
                        subscriber.complete();
                    }
                });
        });
    }

    destroy() {
        this._isDead = true;
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
    }
}