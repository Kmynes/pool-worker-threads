import { Worker, WorkerOptions } from "worker_threads";
import { Observable } from "rxjs";
import * as fs  from "fs";
import * as util from "util";

const readFile = util.promisify(fs.readFile);

export interface PoolWorkerParams<WorkerDataIn, WorkerDataOut> {
    workerData?:WorkerDataIn
    task:string | (
            (workerData:WorkerDataIn, 
            postMessage:(data:WorkerDataOut) => void) => WorkerDataOut
        )
}

export interface PoolWorkerTask<WorkerDataIn, WorkerDataOut> {
    id:number
    params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>
}

export interface ResMessage<WorkerDataOut> {
    isError:boolean
    error:Error
    desc:{ latest:boolean, processingDuration:number}
    data:WorkerDataOut
}

export class PoolWorker extends Worker {
    private static _idCounter = 0;
    private static _confFunction = `.bind(null, workerData, postMessage)`;
    private _isBusy:boolean;
    private _currentTaskId:number = 0;

    get currentTaskId():number{
        return this._currentTaskId;
    }

    get busy():boolean {
        return this._isBusy;
    }

    private _id:number;
    get id():number {
        return this._id;
    }

    constructor(scriptVM:string, workerOptions:WorkerOptions) {
        super(scriptVM, workerOptions);
        this._isBusy = false;
        this._id = PoolWorker._idCounter++;
    }

    private async _getExecutionCodeFromFile(file:string):Promise<string> {
        const code = await readFile(file);
        return `((function() {\n\t${code.toString("utf8").replace(/\n/g, '\n\t')}\n})${PoolWorker._confFunction})()`;
    }

    private _getExecutionCodeFromTask(task:Function):string {
        const strFn = task.toString();
        const res = /^task[^]*([^]*)[^]*{[^]*}$/.test(strFn) ? 
                    `function ${strFn}` : strFn;
        return `((${res})${PoolWorker._confFunction})()`;
    }

    private _getExecutionCode(provider:string|Function):Observable<string> {
        return new Observable(subscriber => {
            if (typeof provider === "string")
                this._getExecutionCodeFromFile(provider)
                    .then(dataFile => {
                        subscriber.next(dataFile);
                        subscriber.complete();
                    })
                    .catch(reason => {
                        subscriber.error(reason);
                        throw reason;
                    });
            else {
                subscriber.next(
                    this._getExecutionCodeFromTask(provider)
                );
                subscriber.complete();
            }
        });
    }

    private _genError(error:any) {
        return {
            workerId:this._id, 
            error
        };
    }

    runTask<WorkerDataIn, WorkerDataOut>(
        taskWorker:PoolWorkerTask<WorkerDataIn, WorkerDataOut>
        ):Observable<ResMessage<WorkerDataOut>> {
        this._currentTaskId = taskWorker.id;
        const { task, workerData } = taskWorker.params;
        if (typeof task !== "string" && typeof task !== "function")
            throw new Error("You must specify a task as string or as function");
        this._isBusy = true;
        return new Observable<ResMessage<WorkerDataOut>>(subscriber => {
            const oGetExecutionCode = this._getExecutionCode(task);
            oGetExecutionCode
                .subscribe({
                    next:executionCode => {
                        const errorListener = (error:Error) => {
                            subscriber.error(this._genError(error));
                            subscriber.complete();
                            this.removeListener("error", errorListener);
                            this.removeListener("message", messageListener);
                        };
                        const messageListener = (result:ResMessage<WorkerDataOut>) => {
                            if (result.isError) {
                                this.emit("error", result.error);
                                return;
                            }
                            if (result.desc.latest) {
                                subscriber.next(result);
                                subscriber.complete();
                                this._isBusy = false;
                                this._currentTaskId = 0;
                                this.removeListener("error", errorListener);
                                this.removeListener("message", messageListener);
                                this.emit("ready", this);
                            }else
                                subscriber.next(result);
                        };
                        this.on("message", messageListener);
                        this.on("error", errorListener);
                        this.postMessage({
                            executionCode,
                            workerData
                        });
                    },
                    error: reason => {
                        subscriber.complete();
                        throw reason;
                    }
                });
        });
    }
}