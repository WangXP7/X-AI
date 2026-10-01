// One user preview at a time across the library, task cards and dialogs.
export function installPlaybackController(root=document){
  let active=null;
  const pauseAll=()=>{if(active)active.pause();for(const media of root.querySelectorAll('audio,video'))media.pause();active=null;};
  const onPlay=event=>{const media=event.target;if(!['AUDIO','VIDEO'].includes(media.tagName))return;if(active&&active!==media)active.pause();for(const other of root.querySelectorAll('audio,video'))if(other!==media&&!other.paused)other.pause();active=media;};
  const onClose=event=>{if(event.target.tagName!=='DIALOG')return;for(const media of event.target.querySelectorAll('audio,video')){media.pause();if(active===media)active=null;}};
  const observer=new MutationObserver(records=>{for(const record of records)if(record.type==='attributes'&&record.target.tagName==='DIALOG'&&!record.target.open)onClose({target:record.target});if(active&&!active.isConnected){active.pause();active=null;}});
  observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  root.addEventListener('play',onPlay,true);root.addEventListener('close',onClose,true);
  return {pauseAll,dispose(){pauseAll();observer.disconnect();root.removeEventListener('play',onPlay,true);root.removeEventListener('close',onClose,true);}};
}
