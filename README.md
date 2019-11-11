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

## Typical example using observable
```TS
import { WorkerPool } from "pool-worker-threads";

const pool = new WorkerPool(4, true); //Set true will run your pool in strict mode then if an unpected case append it will throw an error

const myObservable = pool.exec<string, string>({
    task(data, post) {
        post("My message 1"); //You can easily emit some message from your thread by using you second argument
        var str = "ba";
        for (var i = 0; i < 2; i++)
            str += str;
        post("My message 2"); 
        return str; //This is you final post
    }
});
myObservable
    .subscribe((msg:string) => {
        console.log(msg); // At every post you will receive a notification with the data here
        if (msg === "babababa")
            process.exit(0);
    });

process.on("exit",(_) => {
    //Don't forget to destroy your pool when you finished with it
    pool.destroy();
});
```
Choose `Observable` as object allow you to easily use your worker results with an `Promise` approach by using

```TS
const obs = new Observable()
const promise = obs.toPromise(); //This is your promise it 'll wait for all your worker messages
```

## Typical example using some data with Promise aproach
`WorkerPool.execAwait`

```TS
import { WorkerPool } from "./pool-worker-threads";

const threads = 4;

const pool = new WorkerPool(threads, true);

const secreKey = "my secretKey";

const nbrToken = 10000;

const workersPromises = [];

//For some reason We'll build an array of jwt token
for (let i = 0; i < threads; i++) {
    const workerData = {
        nbrTokenYouMustBuild:nbrToken/threads,
        secret:secreKey
    };
    type WorkerDataIn = {nbrTokenYouMustBuild:number, secret:string};
    //If you are a responsible developer you are coding with typscript
    //Thus you should create some type.
    /* 
        * It would works like that also
        pool.exec<{nbrTokenYouMustBuild:number, secret:string}, string[]>({ ....
            ....
        })
        * But I am a proper person
    */
    const workerPromise =  pool.execAwait<WorkerDataIn, string[]>({
            workerData,
            task(data:WorkerDataIn, post:Function):string[] {
                //Be carefule the code here must be writte in JS
                const jwt  = require("jsonwebtoken"); //Thus we use a require instead of import
                const tokens = [];
                const { nbrTokenYouMustBuild, secret } = data;
                while (tokens.length !== nbrTokenYouMustBuild) {
                    const payload = { data:"gitHub:Kmynes" };
                    const tokenOptions = { expiresIn: '1h' };
                    const token = jwt.sign(payload, secret, tokenOptions);
                    tokens.push(token);
                }

                return tokens; //We send one message at the, but we could send it by piece
            }
        }); //You can easily accumulate all datas emited in a promise
    workersPromises.push(workerPromise);
}

Promise.all(workersPromises)
    .then((workersResults:string[][]) => {
        const tokens = workersResults.reduce(
            (accRes, currRes) => accRes.concat(currRes) //We just create a big array with all tokens
        );
        if (tokens.length === 1000)
            console.log("Test execWaitOnce success");
        else
            console.error("Test execWaiteOnce failure");
        pool.destroy();
    }).catch(e => { 
        console.error("Test execWaiteOnce failure ", e); 
    });
```

## Task with Async/Await

In your tasks you can easily return a promise and it 'll be resolved before send it as a message to your Observable.

### Typical use case

```TS
import { WorkerPool } from "./pool-worker-threads";

const pool = new WorkerPool(4, true);

var oneIsPassed = false;

const subScribeListenner = (n:Number) => {
    console.log(n);
    if (!oneIsPassed)
        oneIsPassed = true; //Don't worry it seams nodejs is always single-tread then it 'll works 
    else
        pool.destroy();
};

pool.exec<Number, Number>({
    workerData:10,
    //@ts-ignore
    //Because typescript can't understand this function will not understand this function will be executed in a nice VM we must ingore it.
    task: (number:Number, post:Function):Promise<Number> => {
        return Promise.resolve(number);
    }
}).subscribe(subScribeListenner);

/*
// /!\ Don't use async await on a task declared in a typscript file, but in JS file you can do wathever you want
//The same thing
pool.exec<Number, Number>({
    workerData:10,
    //@ts-ignore
    //Because typescript can't understand this function will not understand this function will be executed in a nice VM we must ingore it.
    task: async (number:Number, post:Function):Promise<Number> => {
        //Please if you are unsing typscript this will not work because it will be transform in somthing VM module don't like
        return await Promise.resolve(number);
    }
}).subscribe(subScribeListenner);*/
```

### Interupt seach
`WorkerPool.execManyDuplicationCloseOnMessage`
```TS
import { WorkerPool } from "../index";
import { generate } from "generate-password"

const threads = 4;

const pool = new WorkerPool(threads, true);

const wordToSearch = generate({ length:120 });

const nbrStr = 3000000;

pool.execAwaitManyDuplication<number, string[]>({
    workerNumber:threads,
    params:{
        workerData:nbrStr,
        task(data:number) {
            const { generate } = require("generate-password");
            const listStr = [];
            while (listStr.length !== data)
                listStr.push(generate({ length:10 }));
            return listStr;
        }
    }
}).then(resList => {
    const list = resList.reduce((acc, curr) => acc.concat(curr))
    list.push(wordToSearch);
    type DataIn = { list:string[], wordToSearch:string };
    const workersData = [] as DataIn[];
    let pad = nbrStr/threads;
    for (var i = 0; i < threads; i++) {
        workersData.push({
            list:list.slice(pad * i, (i+1) * (pad)),
            wordToSearch
        });
    }
    workersData[0].list[200000] = wordToSearch;
    console.time("Search");
    pool.execManyDuplicationCloseOnMessage<DataIn, boolean>({
        workerNumber:threads,
        checkValue(msg) {
            return msg === true;
        },
        workersData,
        task(data:DataIn, post:Function) {
            for (let i = 0; i < data.list.length; i++) {
                if (data.list[i] === data.wordToSearch) {
                    return true;
                }
            }
            return false;
        }
    }).then(res => {
        console.timeEnd("Search");
        console.log(res);
        pool.destroy();
    })
});
```

### `pool.destroy()`

Call `worker.terminate()` for every worker in the pool and release them.