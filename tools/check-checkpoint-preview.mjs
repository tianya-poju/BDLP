import {verifyCheckpointPreview} from '../frontend/js/checkpoint-preview.js';
let text='';for await(const chunk of process.stdin)text+=chunk;
const {points,order,coverage,fence,config}=JSON.parse(text);
console.log(JSON.stringify(verifyCheckpointPreview(points,order,coverage,fence,config)));
