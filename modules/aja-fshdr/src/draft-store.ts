import { applyMutation, clone, inverse, type FsDocument, type Mutation, type CellEdit } from './model.js';
export interface SaveReceipt { document:FsDocument; revision:string|null }
export interface InvalidDraft { edit:CellEdit; message:string }
/** `quiet`: a change the page makes by itself, such as a name a unit reports. If it is refused the operator isn't told. */
interface Pending { id:number; operation:Mutation; undoEntry?:Mutation; quiet?:boolean }
export class DraftStore {
  document:FsDocument; base:FsDocument; revision:string|null;
  pending:Pending[]=[]; invalid=new Map<string,InvalidDraft>(); undo:Mutation[]=[]; redo:Mutation[]=[]; error='';
  epoch=0;
  /** A save of this copy's was refused and it hasn't heard the plan since, so it may be showing an older one. */
  behind=false;
  private next=0; private running=false; private listeners=new Set<()=>void>(); private lastEdit=new Map<string,number>(); private saved:(()=>void)[]=[]; private refusals=new Set<()=>void>();
  constructor(initial:SaveReceipt,private save:(operation:Mutation)=>Promise<SaveReceipt>){this.document=clone(initial.document);this.base=clone(initial.document);this.revision=initial.revision;}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  /** Called once the saves waiting have all been answered, when one of them was refused. */
  onRefused(fn:()=>void){this.refusals.add(fn);return()=>{this.refusals.delete(fn);};}
  private emit(){for(const fn of this.listeners)fn();}
  submit(operation:Mutation,remember=true,quiet=false):boolean{
    const before=this.document;
    try {
      this.document=applyMutation(before,operation);
      this.epoch++;
      const id=++this.next;
      if(operation.kind==='edit')for(const edit of operation.edits){const key=edit.rowId+'/'+edit.columnId;this.invalid.delete(key);this.lastEdit.set(key,id);}
      let undoEntry:Mutation|undefined;
      if(remember){undoEntry=inverse(before,operation);this.undo.push(undoEntry);this.undo=this.undo.slice(-200);this.redo=[];}
      this.pending.push({id,operation,undoEntry,...(quiet?{quiet}:{})});if(!quiet)this.error='';this.emit();void this.drain();return true;
    } catch(error) {
      this.error=error instanceof Error?error.message:String(error);
      if(operation.kind==='edit')for(const edit of operation.edits)this.invalid.set(edit.rowId+'/'+edit.columnId,{edit,message:this.error});
      this.emit();return false;
    }
  }
  /** Resolves once every save made so far has been answered, whether or not it landed. */
  whenSaved():Promise<void>{return this.pending.length?new Promise(resolve=>this.saved.push(resolve)):Promise.resolve();}
  /** The unit has these values now, so the staged copies are finished with and Undo can no longer restore them. */
  confirm(edits:CellEdit[]){
    if(!edits.length||!this.submit({kind:'edit',edits},false,true))return;
    const done=new Set(edits.map(edit=>edit.rowId+'/'+edit.columnId));
    const without=(list:Mutation[])=>list.flatMap((operation):Mutation[]=>{
      if(operation.kind!=='edit')return [operation];
      const rest=operation.edits.filter(edit=>!done.has(edit.rowId+'/'+edit.columnId));
      return rest.length?[{...operation,edits:rest}]:[];
    });
    this.undo=without(this.undo);this.redo=without(this.redo);
  }
  observe(receipt:SaveReceipt,expectedEpoch=this.epoch){
    if(this.pending.length||expectedEpoch!==this.epoch)return;
    if(receipt.revision===this.revision){if(this.behind){this.behind=false;this.emit();}return;}
    this.base=clone(receipt.document);this.document=clone(receipt.document);this.revision=receipt.revision;this.behind=false;this.emit();
  }
  history(forward:boolean){const from=forward?this.redo:this.undo,to=forward?this.undo:this.redo;const op=from.pop();if(!op)return;const reverse=inverse(this.document,op);if(this.submit(op,false))to.push(reverse);else from.push(op);}
  /** A value the unit wouldn't take, caught before it is staged. The typed draft stays in the cell, marked, until it is corrected or discarded. */
  refuse(edit:CellEdit,message:string){this.invalid.set(edit.rowId+'/'+edit.columnId,{edit,message});this.error=message;this.emit();}
  discard(rowId:string,columnId:string){this.invalid.delete(rowId+'/'+columnId);this.error='';this.emit();}
  private reject(item:Pending,error:unknown){if(item.quiet)return;const message=error instanceof Error?error.message:String(error);this.error=message;if(item.undoEntry)this.undo=this.undo.filter(entry=>entry!==item.undoEntry);if(item.operation.kind==='edit')for(const edit of item.operation.edits){if(!edit.value)continue;const key=edit.rowId+'/'+edit.columnId;if(this.lastEdit.get(key)===item.id)this.invalid.set(key,{edit,message});}}
  private async drain(){
    if(this.running)return;this.running=true;let refused=false;
    try {
      while(this.pending.length){
        const item=this.pending[0]!;
        // A save that lands comes back with the whole plan as saved, so the copy is up to date again.
        try {const reply=await this.save(item.operation);this.base=clone(reply.document);this.revision=reply.revision;this.behind=false;}
        catch(error){this.reject(item,error);refused=true;this.behind=true;}
        this.pending.shift();
        let projected=clone(this.base);const remaining:Pending[]=[];
        for(const later of this.pending){try{projected=applyMutation(projected,later.operation);remaining.push(later);}catch(error){this.reject(later,error);refused=true;}}
        this.pending=remaining;this.document=projected;this.emit();
      }
    } finally {this.running=false;for(const resolve of this.saved.splice(0))resolve();if(refused)for(const fn of [...this.refusals])fn();}
  }
}

/**
 * Keeps one open copy of the page on the plan as saved, whichever copy or window saved it last. The worker publishes the
 * plan's revision; a copy with no save of its own waiting reads the plan again when it sees one it doesn't hold. A copy
 * whose save was refused reads it again too, without waiting to hear, so its next edit starts from what is saved.
 * A read never replaces an edit made while it was on its way.
 */
export function followSaved(store: DraftStore, read: () => Promise<SaveReceipt>) {
  let request = 0, disposed = false;
  const catchUp = (revision?: unknown) => {
    if (disposed || store.pending.length) return;
    const ask = ++request, epoch = store.epoch;
    void read().then(next => { if (!disposed && ask === request && epoch === store.epoch && (revision === undefined || next.revision === revision)) store.observe(next, epoch); }, () => {});
  };
  const stop = store.onRefused(() => catchUp());
  return {
    saw(revision: unknown) { if (revision !== undefined && revision !== store.revision) catchUp(revision); },
    dispose() { disposed = true; stop(); },
  };
}

/**
 * Saves the name and mode live units report (see reportedEdits), quietly, and never from a plan this copy knows may be older
 * than one another window saved: that edit would only be refused, and taken again, until the copy had caught up.
 */
export function takeReported(store: DraftStore, edits: () => CellEdit[]): void {
  if (store.pending.length || store.behind) return;
  const found = edits();
  if (found.length) store.submit({ kind: 'edit', edits: found }, false, true);
}
