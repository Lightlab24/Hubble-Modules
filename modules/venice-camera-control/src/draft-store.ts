import { applyMutation, clone, inverse, type CameraDocument, type Mutation, type CellEdit } from './model.js';
export interface SaveReceipt { document:CameraDocument; revision:string|null }
export interface InvalidDraft { edit:CellEdit; message:string }
interface Pending { id:number; operation:Mutation; undoEntry?:Mutation }
export class DraftStore {
  document:CameraDocument; base:CameraDocument; revision:string|null;
  pending:Pending[]=[]; invalid=new Map<string,InvalidDraft>(); undo:Mutation[]=[]; redo:Mutation[]=[]; error='';
  epoch=0;
  private next=0; private running=false; private listeners=new Set<()=>void>(); private lastEdit=new Map<string,number>(); private saved:(()=>void)[]=[];
  constructor(initial:SaveReceipt,private save:(operation:Mutation)=>Promise<SaveReceipt>){this.document=clone(initial.document);this.base=clone(initial.document);this.revision=initial.revision;}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  private emit(){for(const fn of this.listeners)fn();}
  submit(operation:Mutation,remember=true):boolean{
    const before=this.document;
    try {
      this.document=applyMutation(before,operation);
      this.epoch++;
      const id=++this.next;
      if(operation.kind==='edit')for(const edit of operation.edits){const key=edit.rowId+'/'+edit.columnId;this.invalid.delete(key);this.lastEdit.set(key,id);}
      let undoEntry:Mutation|undefined;
      if(remember){undoEntry=inverse(before,operation);this.undo.push(undoEntry);this.undo=this.undo.slice(-200);this.redo=[];}
      this.pending.push({id,operation,undoEntry});this.error='';this.emit();void this.drain();return true;
    } catch(error) {
      this.error=error instanceof Error?error.message:String(error);
      if(operation.kind==='edit')for(const edit of operation.edits)this.invalid.set(edit.rowId+'/'+edit.columnId,{edit,message:this.error});
      this.emit();return false;
    }
  }
  /** Resolves once every save made so far has been answered, whether or not it landed. */
  whenSaved():Promise<void>{return this.pending.length?new Promise(resolve=>this.saved.push(resolve)):Promise.resolve();}
  /** The camera has these values now, so the staged copies are finished with and Undo can no longer restore them. */
  confirm(edits:CellEdit[]){
    if(!edits.length||!this.submit({kind:'edit',edits},false))return;
    const done=new Set(edits.map(edit=>edit.rowId+'/'+edit.columnId));
    const without=(list:Mutation[])=>list.flatMap((operation):Mutation[]=>{
      if(operation.kind!=='edit')return [operation];
      const rest=operation.edits.filter(edit=>!done.has(edit.rowId+'/'+edit.columnId));
      return rest.length?[{...operation,edits:rest}]:[];
    });
    this.undo=without(this.undo);this.redo=without(this.redo);
  }
  observe(receipt:SaveReceipt,expectedEpoch=this.epoch){if(this.pending.length||expectedEpoch!==this.epoch||receipt.revision===this.revision)return;this.base=clone(receipt.document);this.document=clone(receipt.document);this.revision=receipt.revision;this.emit();}
  history(forward:boolean){const from=forward?this.redo:this.undo,to=forward?this.undo:this.redo;const op=from.pop();if(!op)return;const reverse=inverse(this.document,op);if(this.submit(op,false))to.push(reverse);else from.push(op);}
  discard(rowId:string,columnId:string){this.invalid.delete(rowId+'/'+columnId);this.error='';this.emit();}
  private reject(item:Pending,error:unknown){const message=error instanceof Error?error.message:String(error);this.error=message;if(item.undoEntry)this.undo=this.undo.filter(entry=>entry!==item.undoEntry);if(item.operation.kind==='edit')for(const edit of item.operation.edits){if(!edit.value)continue;const key=edit.rowId+'/'+edit.columnId;if(this.lastEdit.get(key)===item.id)this.invalid.set(key,{edit,message});}}
  private async drain(){
    if(this.running)return;this.running=true;
    try {
      while(this.pending.length){
        const item=this.pending[0]!;
        try {const reply=await this.save(item.operation);this.base=clone(reply.document);this.revision=reply.revision;}
        catch(error){this.reject(item,error);}
        this.pending.shift();
        let projected=clone(this.base);const remaining:Pending[]=[];
        for(const later of this.pending){try{projected=applyMutation(projected,later.operation);remaining.push(later);}catch(error){this.reject(later,error);}}
        this.pending=remaining;this.document=projected;this.emit();
      }
    } finally {this.running=false;for(const resolve of this.saved.splice(0))resolve();}
  }
}
