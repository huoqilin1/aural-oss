import {createContext} from './context';
import {assertSessionAccess} from './session-access';
import {SessionAccessError} from '@/lib/voice/session-access';
export async function sessionAccessResponse(sessionId:unknown,expectedInterviewId?:string):Promise<Response|null> {
  try {await assertSessionAccess(await createContext(),sessionId,true,expectedInterviewId);return null;}
  catch(error) {
    return Response.json({error:error instanceof SessionAccessError ? error.message : 'Unable to verify interview access'},
      {status:error instanceof SessionAccessError ? error.status : 503});
  }
}
