import { EventEmitter } from "events";
import { PoolWorker, PoolWorkerTask, ResMessage } from "./pool-worker";
import { Observable } from "rxjs";

interface TaskDesc {
    task:PoolWorkerTask<any, any>
    fn:(woker:PoolWorker) => void
}

export class WaitingQueue extends EventEmitter {
    private _queue: TaskDesc[] = [];
    constructor() {
        super();
        this.on("worker-ready", (worker:PoolWorker) => {
            const taskDesc = this._queue.shift();
            if (taskDesc)
                taskDesc.fn(worker);
        });
    }

    removeFromQueue(taskId:number):void {
        var taskIndex = -1;
        while ((taskIndex = this._queue.findIndex(
                task => task.task.id === taskId)) !== -1) {
                this._queue.splice(taskIndex, 1);
            }
    }

    runTask<WorkerDataIn, WorkerDataOut>(
        task:PoolWorkerTask<WorkerDataIn, WorkerDataOut>) {
        return new Observable<ResMessage<WorkerDataOut>>(
            subscriber => {
                const handlerWorkerReady = (worker:PoolWorker) => {
                    worker.runTask<WorkerDataIn, WorkerDataOut>(task)
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
                };
                this._queue.push({
                    task,
                    fn:handlerWorkerReady
                });
            });
    }
}