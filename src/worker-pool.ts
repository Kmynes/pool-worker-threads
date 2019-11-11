import { Observable } from "rxjs";
import { 
    PoolWorker, 
    PoolWorkerParams, 
    PoolWorkerTask, 
    ResMessage 
} from "./pool-worker";
import { WaitingQueue } from "./waiting-queue";

interface DuplicationParams<WorkerDataIn, WorkerDataOut> {
    workerNumber:number
    params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>
}

interface InteruptParams<WorkerDataIn, WorkerDataOut>  {
    workerNumber:number
    workersData:WorkerDataIn[]
    checkValue:(value:WorkerDataOut) => boolean
    task:string | (
        (workerData:WorkerDataIn, 
        postMessage:(data:WorkerDataOut) => void) => WorkerDataOut
    )
}

export class WorkerPool {
    private static readonly vmCode:string = `
        const vm = require('vm');
        const p_WorkerPool = require('worker_threads').parentPort;
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
                isError:false,
                data,desc
            };
            p_WorkerPool.postMessage(ret);
        };

        p_WorkerPool.on('message', async ({ executionCode, workerData }) => {
            try {
                const start = Date.now();
                lastMessageDate = start;
                const sandbox = {postMessage, workerData, require, console};
                const result = await vm.runInNewContext(executionCode, sandbox);
                const desc = {
                    processingDuration:Date.now() - start,
                    latest:true
                };
                postMessage(result, desc);
            }catch(error) {
                p_WorkerPool.postMessage({isError:true, error});
            }
        });
    `;
    private static taskCounter:number = 0;

    private workers:PoolWorker[];
    private _isDead:boolean = false;
    private _queue:WaitingQueue;
    private _strict:boolean;
    get isDead():boolean {
        return this._isDead;
    }

    get workersFree():Number {
        return this._getFreeWorkers().length;
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

            this._replace(worker);
            worker.terminate();
            worker.removeAllListeners();
        });
    }

    private _getFreeWorkers() {
        return this.workers.filter(w => !w.busy);
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
        if (worker.currentTaskId !== 0)
            this._queue.removeFromQueue(worker.currentTaskId);
        this._replace(worker);
        worker.terminate();
        worker.removeAllListeners();
    }

    private _replace(worker:PoolWorker):void {
        const i = this.workers.indexOf(worker);
        if (i > -1)
            this.workers[i] = this._createWorker();
        else
            throw new Error(`Unexpected error can't find worker [${worker.id}] in list`);
    }

    private _exec<WorkerDataIn, WorkerDataOut>(
        task:PoolWorkerTask<WorkerDataIn, WorkerDataOut>)
        :{taskId:number, obs:Observable<WorkerDataOut>} {
            if (this._isDead)
                throw new Error(`This pool was destroyed, create an other one`);

            var worker = this.workers.find(w => !w.busy);
            var oTask:Observable<ResMessage<WorkerDataOut>>
            if (!worker)
                oTask = this._queue.runTask<WorkerDataIn, WorkerDataOut>(task);
            else
                oTask = worker.runTask<WorkerDataIn, WorkerDataOut>(task);
            const obs = new Observable<WorkerDataOut>(subscriber => {
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
            return {taskId:task.id, obs};
    }

    /**
     * @param params
     * @description Execute a worker and provide an observable
     * wich emit a message on each worker post 
     */
    exec<WorkerDataIn, WorkerDataOut>(
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>)
        :Observable<WorkerDataOut> {
            const task = {
                id:++WorkerPool.taskCounter,
                params
            };
            return this._exec(task).obs;
    }

    /**
     * @param params 
     * @description Execute a worker and accumulates his data, 
     * then resolve it by a promise
     */
    execAwait<WorkerDataIn, WorkerDataOut>(
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>)
        :Promise<WorkerDataOut> {
            return this.exec<WorkerDataIn, WorkerDataOut>(params)
                .toPromise();
    }

    /**
     * @param params
     * @description Use for execute many workers with different params
     */
    execMany<WorkerDataIn, WorkerDataOut>(
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>[])
        :Observable<WorkerDataOut>[] {
            return params.map(p => this.exec<WorkerDataIn, WorkerDataOut>(p));
    }

    /**
     * @param params
     * @description Use for execute many workers with different params 
     * and provide an answer with all results with a promise
     */
    execAwaitMany<WorkerDataIn, WorkerDataOut>(
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>[])
        :Promise<WorkerDataOut[]> {
            return Promise.all(
                this.execMany<WorkerDataIn, WorkerDataOut>(params)
                    .map(obs => obs.toPromise<WorkerDataOut>())
            );
    }

    /**
     * @param duplication
     * @description Use to get an observable list for duplicate workers
     */
    execManyDuplication<WorkerDataIn, WorkerDataOut>(
        duplication:DuplicationParams<WorkerDataIn, WorkerDataOut>) 
        :Observable<WorkerDataOut>[]{
            const obsList = [];
            for (let i = 0; i < duplication.workerNumber; i++) {
                obsList.push(
                    this.exec<WorkerDataIn, WorkerDataOut>(duplication.params)
                );
            }
            return obsList;
    }

    /**
     * @param duplication 
     * @description 
     */
    execAwaitManyDuplication<WorkerDataIn, WorkerDataOut>(
        duplication:DuplicationParams<WorkerDataIn, WorkerDataOut>)
        :Promise<WorkerDataOut[]> {
            const promises = this.execManyDuplication(duplication)
            .map(obs => obs.toPromise());
            return Promise.all(promises);
    }



    /**
     * @param interuptParams 
     * @description Use for run many multiple workers and interupt 
     * all of them when a worker provide the expected message.
     * Typically use for make research on a list
     */
    execManyDuplicationCloseOnMessage<WorkerDataIn, WorkerDataOut>(
        interuptParams:InteruptParams<WorkerDataIn, WorkerDataOut>
        ):Promise<WorkerDataOut|string> {
            return new Promise(resolve => {
                if (typeof interuptParams.workerNumber !== "number")
                    throw new Error("Please provide a workerNumber");
                if (typeof interuptParams.checkValue !== "function")
                    throw new Error("Pleace provide a checkValue function");

                const taskCounter = ++WorkerPool.taskCounter;
                const obsList = [] as Observable<WorkerDataOut>[];
                for (let i = 0; i < interuptParams.workerNumber; i++) {
                    const task:PoolWorkerTask<WorkerDataIn, WorkerDataOut> = {
                        id:taskCounter,
                        params:{
                            task:interuptParams.task,
                            workerData:interuptParams.workersData[i]
                        }
                    };
                    obsList.push(this._exec<WorkerDataIn, WorkerDataOut>(task).obs);
                }

                var answerProvided = false;
                var counterComplet = 0;
                for (let obs of obsList) {
                    obs.subscribe({
                        next:value => {
                            if (interuptParams.checkValue(value)) {
                                if (!answerProvided) {
                                    this.workers
                                        .filter(w => w.currentTaskId === taskCounter)
                                        .forEach(w => this._removeWorker(w.id));
                                    resolve(value);
                                    answerProvided = true;
                                }
                            }
                        },
                        complete:() => {
                            counterComplet++;
                            if (counterComplet === obsList.length && !answerProvided) {
                                resolve("Expected value not received");
                            }
                        }
                    });
                }
            });
    }

    /**
     * @description Destroy the pool by releasing workers
     */
    destroy() {
        this._isDead = true;
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
    }
}