import { applyMutation, clone, inverse, type CameraDocument, type Mutation, type CellEdit } from './model.js';
export interface Receipt<D> { document:D; revision:string|null }
export type SaveReceipt=Receipt<CameraDocument>;
export interface InvalidDraft { edit:CellEdit; message:string }
type Change={kind:string;edits?:CellEdit[]};
interface Pending<M> { id:number; operation:M; undoEntry?:M }
/**
 * The page's copy of a saved document. An edit shows straight away and saves in order behind it;
 * a refused save rolls back with whatever depended on it, and everything else stays.
 */
export class Drafts<D,M extends Change> {
  document:D; base:D; revision:string|null;
  pending:Pending<M>[]=[]; invalid=new Map<string,InvalidDraft>(); undo:M[]=[]; redo:M[]=[]; error='';
  epoch=0;
  private next=0; private running=false; private listeners=new Set<()=>void>(); private lastEdit=new Map<string,number>(); private saved:(()=>void)[]=[];
  constructor(initial:Receipt<D>,private save:(operation:M)=>Promise<Receipt<D>>,private apply:(document:D,operation:M)=>D,private reverse:(document:D,operation:M)=>M){this.document=clone(initial.document);this.base=clone(initial.document);this.revision=initial.revision;}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  private emit(){for(const fn of this.listeners)fn();}
  submit(operation:M,remember=true):boolean{
    const before=this.document;
    try {
      this.document=this.apply(before,operation);
      this.epoch++;
      const id=++this.next;
      if(operation.kind==='edit')for(const edit of operation.edits!){const key=edit.rowId+'/'+edit.columnId;this.invalid.delete(key);this.lastEdit.set(key,id);}
      let undoEntry:M|undefined;
      if(remember){undoEntry=this.reverse(before,operation);this.undo.push(undoEntry);this.undo=this.undo.slice(-200);this.redo=[];}
      this.pending.push({id,operation,undoEntry});this.error='';this.emit();void this.drain();return true;
    } catch(error) {
      this.error=error instanceof Error?error.message:String(error);
      if(operation.kind==='edit')for(const edit of operation.edits!)this.invalid.set(edit.rowId+'/'+edit.columnId,{edit,message:this.error});
      this.emit();return false;
    }
  }
  /** Resolves once every save made so far has been answered, whether or not it landed. */
  whenSaved():Promise<void>{return this.pending.length?new Promise(resolve=>this.saved.push(resolve)):Promise.resolve();}
  /** The camera has these values now, so the staged copies are finished with and Undo can no longer restore them. */
  confirm(edits:CellEdit[]){
    if(!edits.length||!this.submit({kind:'edit',edits} as unknown as M,false))return;
    const done=new Set(edits.map(edit=>edit.rowId+'/'+edit.columnId));
    const without=(list:M[])=>list.flatMap((operation):M[]=>{
      if(operation.kind!=='edit')return [operation];
      const rest=operation.edits!.filter(edit=>!done.has(edit.rowId+'/'+edit.columnId));
      return rest.length?[{...operation,edits:rest}]:[];
    });
    this.undo=without(this.undo);this.redo=without(this.redo);
  }
  observe(receipt:Receipt<D>,expectedEpoch=this.epoch){if(this.pending.length||expectedEpoch!==this.epoch||receipt.revision===this.revision)return;this.base=clone(receipt.document);this.document=clone(receipt.document);this.revision=receipt.revision;this.emit();}
  history(forward:boolean){const from=forward?this.redo:this.undo,to=forward?this.undo:this.redo;const op=from.pop();if(!op)return;const reverse=this.reverse(this.document,op);if(this.submit(op,false))to.push(reverse);else from.push(op);}
  discard(rowId:string,columnId:string){this.invalid.delete(rowId+'/'+columnId);this.error='';this.emit();}
  private reject(item:Pending<M>,error:unknown){const message=error instanceof Error?error.message:String(error);this.error=message;if(item.undoEntry)this.undo=this.undo.filter(entry=>entry!==item.undoEntry);if(item.operation.kind==='edit')for(const edit of item.operation.edits!){if(!edit.value)continue;const key=edit.rowId+'/'+edit.columnId;if(this.lastEdit.get(key)===item.id)this.invalid.set(key,{edit,message});}}
  private async drain(){
    if(this.running)return;this.running=true;
    try {
      while(this.pending.length){
        const item=this.pending[0]!;
        try {const reply=await this.save(item.operation);this.base=clone(reply.document);this.revision=reply.revision;}
        catch(error){this.reject(item,error);}
        this.pending.shift();
        let projected=clone(this.base);const remaining:Pending<M>[]=[];
        for(const later of this.pending){try{projected=this.apply(projected,later.operation);remaining.push(later);}catch(error){this.reject(later,error);}}
        this.pending=remaining;this.document=projected;this.emit();
      }
    } finally {this.running=false;for(const resolve of this.saved.splice(0))resolve();}
  }
}
/** Camera Control's camera plan. */
export class DraftStore extends Drafts<CameraDocument,Mutation> {
  constructor(initial:SaveReceipt,save:(operation:Mutation)=>Promise<SaveReceipt>){super(initial,save,applyMutation,inverse);}
}
