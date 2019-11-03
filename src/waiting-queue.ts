import { EventEmitter } from "events";
import { PoolWorker, PoolWorkerParams, ResMessage } from "./pool-worker";
import { Observable } from "rxjs";

type TaskFn = (woker:PoolWorker) => void;

export class WaitingQueue extends EventEmitter {
    private _queue: TaskFn[] = [];
    constructor() {
        super();
        this.on("worker-ready", (worker:PoolWorker) => {
            const taskFn = this._queue.shift();
            if (taskFn) {
                taskFn(worker);
            }
        });
    }

    runTask<WorkerDataIn, WorkerDataOut>(
        params:PoolWorkerParams<WorkerDataIn, WorkerDataOut>) {
        return new Observable<ResMessage<WorkerDataOut>>(
            subscriber => {
                this._queue.push((worker:PoolWorker) => {
                    worker.runTask<WorkerDataIn, WorkerDataOut>(params)
                        .subscribe({
                            next: result => {
                                subscriber.next(result);
                                if (result.desc.latest)
                                    subscriber.complete();
                            },
                            error: reason => {
                                subscriber.error(reason);
                                subscriber.complete();
                            },
                            complete: () => {
                                subscriber.complete();
                            }
                        });
                });
            });
    }
}