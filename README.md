# pool-worker-threads

Worker threads pool using Node's worker_threads module. Compitible with ES6+,Typscript, Observable, thus Promise Async/Await.

## Notification
1. This module can only run in Node.js 12 or higher.

## Installation

```
npm install pool-worker-threads --save
```

## `Class: WorkerPool`
Instance of WorkerPool is a threads pool executes different task functions provided every call.

### `new WorkerPool(size)`

- `size` `<number>` Number of workers in this pool.

### `pool.exec(opt)`

- `opt`
  - `task` `<function>` Function as a task to do. **Notice: You can not use closure in task function! If you do want to use external data in the function, you can use workerData to pass some [cloneable data](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).**
  - `workerData` `<any>` [Cloneable data](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) you want to access in task function.
- Returns: `<Observable>`

Choose one idle worker in the pool to execute your task function. The Promise is resolved with the result your task returned.

### `pool.destroy()`

Call `worker.terminate()` for every worker in the pool and release them.