import { describe, expect, it, vi } from 'vitest';
import { openTrustedServerWorkspace } from '../src/app/trustedServerWorkspace';
const shell = {ok:true,sessionName:'home',folder:'/home/orin',reused:false,via:'aplexer' as const,aplexerId:'fixture',error:null,code:null};
const base = () => ({current:vi.fn(async()=>true),lastFolder:null as string|null,list:vi.fn(async()=>({sessions:[],errors:[]})),home:vi.fn(async()=>'/home/orin'),start:vi.fn(async()=>shell),pending:vi.fn()});
describe('trusted server one-tap workspace',()=>{
  it('opens a fresh server home shell without a form',async()=>{const d=base();expect(await openTrustedServerWorkspace(d)).toEqual({folder:'/home/orin',session:'home'});expect(d.start).toHaveBeenCalledWith('/home/orin');expect(d.pending).toHaveBeenCalled();});
  it('reuses live home shell instead of duplicating it',async()=>{const d=base();d.list.mockResolvedValue({sessions:[{name:'existing',path:'/home/orin',created:0,activity:0,attached:false}] as never[],errors:[]});expect(await openTrustedServerWorkspace(d)).toEqual({folder:'/home/orin',session:'existing'});expect(d.start).not.toHaveBeenCalled();});
  it('restores a valid last folder with existing selection',async()=>{const d=base();d.lastFolder='/git/project';d.list.mockResolvedValue({sessions:[{name:'work',workspace:'/git/project',path:'/git/project',created:0,activity:0,attached:false}] as never[],errors:[]});expect(await openTrustedServerWorkspace(d)).toEqual({folder:'/git/project'});expect(d.home).not.toHaveBeenCalled();});
  it('does not create on another account/connection after an await',async()=>{const d=base();d.current.mockResolvedValueOnce(true).mockResolvedValueOnce(false);await expect(openTrustedServerWorkspace(d)).rejects.toThrow('changed');expect(d.start).not.toHaveBeenCalled();});
  it.each(['C:/Users/User','C:\\Users\\User'])('accepts Windows home %s with shared path normalization',async(home)=>{const d=base();d.home.mockResolvedValue(home);d.start.mockResolvedValue({...shell,folder:home});expect(await openTrustedServerWorkspace(d)).toEqual({folder:'C:/Users/User',session:'home'});expect(d.pending).toHaveBeenCalledWith({...shell,folder:home},'C:/Users/User');});
});
