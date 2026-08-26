//! Windows-only: put the bridge child in a kill-on-close job object.
//!
//! Mirrors Native.CreateKillOnCloseJob in the main repository's WinForms shell. Without it,
//! a crashed shell would leave an orphaned bridge holding the Discord voice connection and
//! the control port; with it, the OS cleans up no matter how this process ends.

use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::process::Child;

use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};

pub fn kill_on_close(child: &Child) -> io::Result<()> {
    unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null()).map_err(|e| io::Error::other(e.message()))?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = windows::Win32::System::JobObjects::SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok.is_err() {
            return Err(io::Error::other("SetInformationJobObject failed"));
        }

        let process = HANDLE(child.as_raw_handle() as _);
        AssignProcessToJobObject(job, process).map_err(|e| io::Error::other(e.message()))?;

        // Leak the job handle deliberately: it must outlive this function, and closing it is
        // exactly what kills the child. The OS closes it when this process exits or crashes.
        core::mem::forget(job);
        Ok(())
    }
}
