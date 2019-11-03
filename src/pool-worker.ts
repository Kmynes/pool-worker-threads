import { Worker, WorkerOptions } from "worker_threads";
import { Observable } from "rxjs";
import * as fs  from "fs";
import * as util from "util";

const readFile = util.promisify(fs.readFile);
const exists = util.promisify(fs.exists);

export class PoolWorkerParams<WorkerDataIn, WorkerDataOut> {
    task?:Function
    file?:string
    workerData?:WorkerDataIn
    postMessage?:(data:WorkerDataOut) => void
}

export interface ResMessage<WorkerDataOut> {
    desc:{ latest:boolean, processingDuration:number}, 
    data:WorkerDataOut
}

export class PoolWorker extends Worker {
    private static _idCounter = 0;
    private _isBusy:boolean;
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
        return `(function() {\n\t${code.toString("utf8").replace(/\n/g, '\n\t')}\n})()`;
    }

    private _getExecutionCodeFromTask(task:Function):string {
        return `(${task.toString()})()`;
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
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>
        ):Observable<ResMessage<WorkerDataOut>> {
        const { task, file, workerData } = params;
        if (task && file)
            throw new Error("You can't specify task and file but only one of them");
        else if (!task && !file)
            throw new Error("You must specify a souce of code task or file");

        this._isBusy = true;
        return new Observable<ResMessage<WorkerDataOut>>(subscriber => {
            const oGetExecutionCode = this._getExecutionCode(task ? task as Function : file as string);
            oGetExecutionCode
                .subscribe({
                    next:executionCode => {
                        this.on("message", (result:ResMessage<WorkerDataOut>) => {
                            if (result.desc.latest) {
                                subscriber.next(result);
                                subscriber.complete();
                                this._isBusy = false;
                                this.emit("ready", this);
                            }else
                                subscriber.next(result);
                        });
                        this.on("error", error => {
                            subscriber.error(this._genError(error));
                            subscriber.complete();
                        });
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