// Fetch cannot distinguish DNS, offline and CORS errors. Keep the operation explicit.
export class ConnectionError extends Error{
  constructor(operation,connection,error){
    const timeout=['TimeoutError','AbortError'].includes(error?.name);
    const label={submit:'提交任务',poll:'查询原任务',models:'检查 API 连接',media:'下载视频'}[operation]||'网络请求';
    const reason=timeout?'请求超时':error?.status===403&&connection==='bridge'?'本机配对码或页面来源不匹配':error?.status?'接口返回 '+error.status:connection==='bridge'?'无法连接本机连接器':connection==='local'?'本机视频下载通道中断，原地址保留':'浏览器未能读取响应（网络或跨域问题）';
    super(label+'失败：'+reason+'。'+(operation==='media'?'原任务与视频地址已保留，程序将自动恢复下载。':operation==='submit'?'提交结果可能不明，先核实原任务，不能重复提交。':'已有任务编号保留，请修复连接后继续查询。'));
    this.name='ConnectionError';this.operation=operation;this.connection=connection;this.code=timeout?'timeout':error?.status?'http_'+error.status:'fetch_unreadable';
    this.code=({EmptyDownload:'empty_download',IncompleteDownload:'incomplete_download',InvalidMedia:'invalid_media',CorruptDownload:'decode_failed',MediaChannelUnavailable:'media_channel_unavailable',MediaSessionExpired:'media_session_expired'})[error?.name]||this.code;
    this.status=error?.status;this.permanent=!!error?.permanent;
  }
}
export function networkRecord(error){return error instanceof ConnectionError?{at:new Date().toISOString(),operation:error.operation,connection:error.connection,code:error.code,message:error.message,...(error.retryAt?{retryAt:error.retryAt}:{}),...(error.diagnostic?{diagnostic:error.diagnostic}:{})}:null;}
export function taskProblem(job){
  const a=job.attempts?.at(-1),status=String(a?.pollResponse?.status||'').toLowerCase(),completed=!!a?.url||['completed','success','succeeded'].includes(status);
  if(job.state==='blocked'&&completed&&!job.current){
    const operation=a?.lastProblem?.operation;
    const local=!!a?.rawBlobKey||!!a?.rawPath;
    return {label:local?'已生成 · 本地校验待恢复':'已生成 · 下载待恢复',stage:local?4:3,
      message:operation?job.error:local?'服务端已生成，原文件已保存；本地校验或保存未完成，请恢复原文件处理。':'服务端已生成，但网页下载未完成；原地址保留，可重试下载或下载后导入。',
      remoteCompleted:true,downloadPending:!local};
  }
  return {label:null,stage:null,message:job.error||'',remoteCompleted:completed,downloadPending:false};
}

export function taskStatus(job){
  const a=job.attempts?.at(-1);
  if(job.state==='checking'&&a?.downloadCompleteAt)return '已下载 · 后台校验中';
  if(job.state==='download'&&a?.downloadWaitingFor)return '已生成 · 等待下载通道';
  if(job.state==='download'&&a?.downloadRecovery)return '已生成 · 自动下载中';
  if(job.state==='deferred')return '待提交';
  if(job.state==='unknown')return '已提交 · 待返回';
  if(job.state==='submitting')return a?.sentAt?'已提交 · 待返回':a?.preparedAt&&!a?.submittedAt?'待提交':'正在提交';
  if(job.state==='queued'&&!a?.pollResponse)return '已提交 · 待返回';
  if(job.state==='queued'&&!a?.url&&['completed','success','succeeded'].includes(String(a?.pollResponse?.status||'').toLowerCase()))return '已生成 · 正在获取视频';
  return taskProblem(job).label;
}
