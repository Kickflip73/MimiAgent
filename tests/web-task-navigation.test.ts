import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Browser module.
import { taskExecutionTarget, conversationTasks } from '../src/web/assets/message-view.js';

test('background task opens its execution session, never the parent conversation', () => {
  const task = {taskId:'task-1',sessionId:'worker-1',originSessionId:'owner',status:'running'};
  assert.deepEqual(taskExecutionTarget(task),{session:'worker-1',execution:'task-1'});
  assert.deepEqual(conversationTasks([task,{...task,originSessionId:'another'},{...task,sessionId:'owner'}],'owner'),[task]);
  assert.equal(taskExecutionTarget({...task,sessionId:undefined}),null);
  assert.deepEqual(conversationTasks([{...task,taskId:undefined}],'owner'),[]);
  assert.deepEqual(conversationTasks([{...task,status:'completed'}],'owner'),[{...task,status:'completed'}]);
});
